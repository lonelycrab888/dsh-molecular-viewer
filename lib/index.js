// src/workbench.js
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

// src/download.js
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
var MAX_STRUCTURE_BYTES = 40 * 1024 * 1024;
var reserved = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3]
]) reserved.addSubnet(network, bits);
for (const [network, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]]) {
  reserved.addSubnet(network, bits, "ipv6");
}
var globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");
function publicAddress({ address, family }) {
  if (family === 4) return !reserved.check(address);
  return family === 6 && globalIPv6.check(address, "ipv6") && !reserved.check(address, "ipv6");
}
async function get(url, signal) {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Structure downloads require an HTTPS URL without credentials.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await lookup(hostname, { all: true });
  const endpoint = addresses.find(publicAddress);
  if (!endpoint) throw new Error("Structure downloads require a public network address.");
  signal.throwIfAborted();
  return new Promise((resolve2, reject) => {
    const req = request(url, {
      agent: false,
      family: endpoint.family,
      lookup: (_host, _options, callback) => callback(null, endpoint.address, endpoint.family),
      headers: { "user-agent": "DSH-Molecular-Viewer (DeepSeek Harness plugin)" },
      signal
    }, resolve2);
    req.on("error", reject);
    req.end();
  });
}
async function readStructureBytes(stream, length) {
  const chunks = [];
  let size = 0;
  if (Number(length) > MAX_STRUCTURE_BYTES) throw new Error("Structure file exceeds the 40 MiB limit.");
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_STRUCTURE_BYTES) throw new Error("Structure file exceeds the 40 MiB limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
async function downloadStructureBytes(input, signal, label) {
  let url = new URL(input);
  const timeout = AbortSignal.timeout(45e3);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await get(url, deadline);
    try {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        url = new URL(response.headers.location, url);
        continue;
      }
      if (response.statusCode !== 200) throw new Error(`${label} returned HTTP ${response.statusCode}.`);
      return { bytes: await readStructureBytes(response, response.headers["content-length"]), url };
    } finally {
      if (!response.complete) response.destroy();
    }
  }
  throw new Error(`${label} exceeded the redirect limit.`);
}

// src/workbench-engine.js
import { fileURLToPath, pathToFileURL } from "node:url";
var upstream = new URL("../vendor/structure-viewer/", import.meta.url);
async function connectWorkbench(root, stateDirectory) {
  const { createStructureViewerServer } = await import(new URL("dist/server.mjs", upstream));
  const server = createStructureViewerServer({
    stateDirectory,
    bundledExamplesDirectory: fileURLToPath(new URL("examples/", upstream))
  });
  const pending = /* @__PURE__ */ new Map();
  let nextId = 0;
  const transport = {
    async start() {
    },
    async send(message) {
      if (message.method === "roots/list") {
        queueMicrotask(() => transport.onmessage({
          jsonrpc: "2.0",
          id: message.id,
          result: { roots: [{ uri: pathToFileURL(root).href, name: "DSH workspace" }] }
        }));
      } else if ("id" in message) {
        const settle = pending.get(message.id);
        if (!settle) return;
        if (message.error) settle(new Error(message.error.message));
        else settle(null, message.result === void 0 ? void 0 : JSON.parse(JSON.stringify(message.result)));
      }
    },
    async close() {
      for (const settle of pending.values()) settle(new Error("The molecular workbench disconnected."));
      transport.onclose?.();
    }
  };
  await server.connect(transport);
  function request2(method, params, signal, timeoutMs = 18e4) {
    signal?.throwIfAborted();
    return new Promise((resolve2, reject) => {
      const id = ++nextId;
      function settle(error, result) {
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve2(result);
      }
      function cancel() {
        if (!pending.has(id)) return;
        const reason = signal?.aborted ? "Request cancelled." : "Molecular workbench request timed out.";
        settle(new Error(reason));
        transport.onmessage({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: id, reason }
        });
      }
      const timer = setTimeout(cancel, timeoutMs);
      timer.unref();
      pending.set(id, settle);
      signal?.addEventListener("abort", cancel, { once: true });
      transport.onmessage({ jsonrpc: "2.0", id, method, params });
    });
  }
  try {
    await request2("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: "dsh-molecular-workbench", version: "0.1.0" }
    }, void 0, 1e4);
    transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    const { tools } = await request2("tools/list", {}, void 0, 1e4);
    return {
      request: request2,
      tools: new Map(tools.map((tool2) => [tool2.name, tool2])),
      call: (name, args, signal) => request2("tools/call", { name, arguments: args }, signal),
      close: () => server.close()
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

// src/workbench-contract.js
var PLUGIN_ID = "dsh-molecular-viewer";
var WORKBENCH_TOOL = "molecular_workbench";
var WORKBENCH_ROUTE = "/dsh-molecular-viewer/workbench";
var STRUCTURE_EXTENSIONS = [
  "pdb",
  "cif",
  "mmcif",
  "mol",
  "sdf",
  "mol2",
  "pqr",
  "pdbqt",
  "gro",
  "xyz",
  "pdb.gz",
  "cif.gz",
  "mmcif.gz",
  "pdb.bgz",
  "cif.bgz",
  "mmcif.bgz",
  "pdb.bgzf",
  "cif.bgzf",
  "mmcif.bgzf"
];
var BINARY_STRUCTURE_EXTENSIONS = STRUCTURE_EXTENSIONS.filter((extension) => extension.includes("."));
function workbenchId(value) {
  return typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
}

// src/workbench.js
var workbenchActions = /* @__PURE__ */ new Set(["open", "viewers", "status", "context", "operations", "help", "run"]);
var shorthandOperations = /* @__PURE__ */ new Map([
  ["status", "structure.get_viewer_status"],
  ["context", "structure.get_context"]
]);
var blockedOpen = /* @__PURE__ */ new Set(["structure.open", "structure.open_from_chat", "structure.open_in_side_pane"]);
var publishingOperations = /* @__PURE__ */ new Set([
  "structure.export",
  "structure.render_image",
  "structure.render_movie",
  "structure.load_public_density"
]);
var CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline' blob:",
  "img-src data: blob:",
  "worker-src blob:",
  "font-src data:",
  "media-src blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "sandbox allow-scripts allow-downloads"
].join("; ");
function profileDirectory() {
  return resolve(process.env.DSH_HOME || join(homedir(), ".dsh"), "cache", "dsh-molecular-workbench");
}
function containsPath(root, absolutePath) {
  const portion = relative(root, absolutePath);
  return portion !== ".." && !portion.startsWith(`..${sep}`) && !isAbsolute(portion);
}
async function sourcePath(root, address) {
  const file = await realpath(resolve(root, address));
  if (!containsPath(root, file)) throw new Error("Choose a structure inside this DSH workspace.");
  if (!(await stat(file)).isFile()) throw new Error("Choose a regular structure file.");
  return file;
}
function importSource(input) {
  if (/^(?:pdb:)?[1-9][a-z0-9]{3}$/i.test(input)) {
    const id = input.replace(/^pdb:/i, "").toUpperCase();
    return { url: `https://files.rcsb.org/download/${id}.cif`, name: `${id}.cif` };
  }
  if (/^https:\/\//i.test(input)) return { url: input };
  if (/^data_\S+/i.test(input)) return { text: input, name: "inline.cif" };
  if (/^(?:ATOM  |HETATM|HEADER|TITLE )/m.test(input)) return { text: input, name: "inline.pdb" };
  return void 0;
}
function safeDownloadName(url, bytes) {
  const name = basename(decodeURIComponent(url.pathname)).replace(/[^a-z0-9._-]/gi, "_").slice(-150);
  if (STRUCTURE_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(`.${extension}`))) return name;
  const start = bytes.toString("utf8", 0, 1024).trimStart();
  if (/^(?:#.*\n)*data_/i.test(start)) return "download.cif";
  if (/^(?:HEADER|TITLE |ATOM  |HETATM|MODEL )/m.test(start)) return "download.pdb";
  throw new Error("The download needs a supported filename extension or recognizable PDB/mmCIF text.");
}
async function importStructure(root, source, signal) {
  let bytes;
  let name = source.name;
  if (source.url) {
    const download = await downloadStructureBytes(source.url, signal, "Molecular structure");
    bytes = download.bytes;
    name ??= safeDownloadName(download.url, bytes);
  } else {
    if (Buffer.byteLength(source.text) > MAX_STRUCTURE_BYTES) throw new Error("Structure file exceeds the 40 MiB limit.");
    bytes = Buffer.from(source.text);
  }
  signal?.throwIfAborted();
  const base = join(root, ".dsh-molecular-sources");
  await mkdir(base, { mode: 448 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(base)).isDirectory() || await realpath(base) !== base) {
    throw new Error("The molecular source directory must be a local workspace directory.");
  }
  const directory = await mkdtemp(join(base, "source-"));
  try {
    const file = join(directory, name);
    await writeFile(file, bytes, { flag: "wx", mode: 384, signal });
    return { file, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
function scene(record, turn) {
  return {
    kind: "workbench",
    id: record.id,
    title: record.title,
    placement: record.placement,
    openedAt: record.openedAt,
    ...turn === void 0 ? {} : { turn }
  };
}
function makeDirectory(owner) {
  return join(profileDirectory(), createHash("sha256").update(owner).digest("hex"));
}
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}
async function parseBody(request2) {
  if (request2.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new Error("The request requires application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request2) {
    size += chunk.length;
    if (size > 32 * 1024 * 1024) throw new Error("The workbench request exceeds 32 MiB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}
function visibleTo(tool2, audience) {
  return tool2?._meta?.ui?.visibility?.includes(audience);
}
function publicResult(action, result) {
  const text = result.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const ok = !result.isError && result.structuredContent?.applied !== false;
  return {
    ok,
    action,
    summary: text || (!ok ? "The molecular operation failed." : "Molecular operation completed."),
    ...result.structuredContent === void 0 ? {} : { data: result.structuredContent }
  };
}
async function writePrivateJson(directory, file, value) {
  const temporary = join(directory, `record-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 384, flag: "wx" });
    await rename(temporary, join(directory, file));
  } finally {
    await rm(temporary, { force: true });
  }
}
async function readLastDistance(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "last-distance.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return void 0;
  }
}
async function callForViewer(engine, record, operation, input, signal) {
  return engine.call(operation, { ...input, sessionId: record.sessionId }, signal);
}
async function runForViewer(engine, record, directory, operation, input, signal) {
  const result = await callForViewer(engine, record, operation, input, signal);
  if (!result.isError && result.structuredContent?.applied !== false && operation === "structure.control_viewer" && input.action === "measure_residue_distance") {
    const measurement = result.structuredContent?.state;
    const revised = await callForViewer(engine, record, "structure.get_context", {
      sections: ["overview"],
      maxItems: 1
    }, signal);
    const geometryRevision = revised.structuredContent?.geometryRevision;
    if (measurement?.measurement && Number.isInteger(geometryRevision)) {
      await writePrivateJson(directory, "last-distance.json", {
        geometryRevision,
        summary: publicResult("run", result).summary,
        measurement
      });
    }
  }
  if (!result.isError && operation === "structure.get_context") {
    const lastDistance = await readLastDistance(directory);
    if (lastDistance && lastDistance.geometryRevision === result.structuredContent?.geometryRevision) {
      return {
        ...result,
        content: [...result.content ?? [], { type: "text", text: `Last closest-heavy-atom measurement: ${lastDistance.summary}` }],
        structuredContent: { ...result.structuredContent, lastResidueDistance: lastDistance.measurement }
      };
    }
  }
  return result;
}
async function selectedResidue(engine, record, signal) {
  const context = await callForViewer(engine, record, "structure.get_context", {
    sections: ["selection"],
    maxItems: 1
  }, signal);
  if (context.isError) throw new Error(publicResult("context", context).summary);
  const selected = context.structuredContent?.sections?.selection?.selected;
  if (!selected?.atomCount) return null;
  const result = await callForViewer(engine, record, "structure.query", {
    expression: { kind: "current", target: "selection" },
    level: "residue",
    limit: 2,
    sceneRevision: context.structuredContent.revision
  }, signal);
  const query = result.structuredContent?.state?.query;
  return query?.rows?.length === 1 && !query.nextCursor ? query.rows[0] : null;
}
function rpcParams(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a molecular operation argument object.");
  }
  return value;
}
function operationName(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error('Supply a nonempty operation name, such as "structure.get_state".');
  }
  const name = value.trim();
  return name.includes(".") ? name : `structure.${name}`;
}
function normalizeToolCall(value) {
  const args = rpcParams(value);
  let action = args.action;
  let operation = args.operation;
  if (action === void 0 && operation !== void 0) {
    action = "run";
  } else if (typeof action === "string" && action.trim() && !workbenchActions.has(action) && operation === void 0) {
    operation = action;
    action = "run";
  }
  if (!workbenchActions.has(action)) {
    throw new Error('Choose a workbench action, such as "open" or "operations", or specify an operation such as "structure.get_state".');
  }
  if (action === "run" || action === "help") operation = operationName(operation);
  else operation = shorthandOperations.get(action);
  if (args.arguments !== void 0 && args.params !== void 0) {
    throw new Error('Supply operation parameters in one field, either "arguments" or "params".');
  }
  const input = args.arguments !== void 0 ? args.arguments : args.params;
  if (input === void 0) return { ...args, action, operation };
  const { viewerId, ...parameters } = rpcParams(input);
  if (args.viewerId !== void 0 && viewerId !== void 0 && args.viewerId !== viewerId) {
    throw new Error("Supply one consistent viewerId for the operation.");
  }
  return { ...args, action, operation, viewerId: args.viewerId ?? viewerId, arguments: parameters };
}
var tool = {
  name: WORKBENCH_TOOL,
  description: [
    "Open and control the live Mol* Molecular Structure Workbench in DSH.",
    'Use open with a workspace file path, RCSB PDB ID, public HTTPS URL, inline PDB/mmCIF, or exampleId "gfp-1ema".',
    "Repeated opens of the same unchanged source in one turn reuse the existing workbench. Reuse its viewerId for comparison, scientific analysis and rendering.",
    "Use context after the user selects or measures something in the viewer. Prefer this tool for new interactive visualizations.",
    'Use action "operations" to list operations or action "help" with an operation name to obtain its input schema. Both work before opening a viewer.',
    'For example, inspect a live viewer with {"action":"run","operation":"structure.get_state"}. The operation name can also be passed as action, or by itself in operation.',
    "For revision-guarded operations, read structure.get_state first. Pass a DSH viewerId only when targeting a specific viewer."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", description: "open, viewers, status, context, operations, help, or run. Also accepts a structure.* operation name as a shortcut." },
      source: { type: "string", description: "A workspace file, RCSB PDB ID, public HTTPS URL, or inline PDB/mmCIF text." },
      exampleId: { type: "string", description: "Use gfp-1ema for the bundled demonstration." },
      viewerId: { type: "string", description: "DSH viewer ID from open or viewers. Defaults to the active viewer." },
      placement: { type: "string", enum: ["inline", "sidebar"], description: "For open. Defaults to inline." },
      operation: { type: "string", description: "For help, run, or when action is omitted. For example, structure.get_state." },
      arguments: { type: "object", additionalProperties: true, description: "Operation arguments. The workbench supplies sessionId." },
      params: { type: "object", additionalProperties: true, description: "Alias for arguments. Supply only one of these fields." }
    }
  },
  output: {
    schema: {
      type: "object",
      required: ["ok", "action", "summary"],
      additionalProperties: true,
      properties: {
        ok: { type: "boolean" },
        action: { type: "string" },
        summary: { type: "string" },
        scene: { type: "object", additionalProperties: true },
        data: { type: "object", additionalProperties: true }
      }
    },
    render: (_args, value) => [{
      type: "text",
      text: value.data === void 0 ? value.summary : `${value.summary}
${JSON.stringify(value.data)}`
    }],
    presentationMeta: (_args, value) => ({
      plugin: PLUGIN_ID,
      ok: value.ok,
      action: value.action,
      summary: value.summary,
      scene: value.scene ?? null
    })
  }
};
function registerWorkbench(ctx, turns) {
  const engines = /* @__PURE__ */ new Map();
  const previewOpens = /* @__PURE__ */ new Map();
  const openRequests = /* @__PURE__ */ new WeakMap();
  const latest = /* @__PURE__ */ new Map();
  async function resolveRoot(agent, signal) {
    return realpath(await ctx.workingDirectory.ensure(agent, signal));
  }
  function engineFor(directory, root) {
    let engine = engines.get(directory);
    if (!engine) {
      engine = connectWorkbench(root, join(directory, "engine"));
      engines.set(directory, engine);
      engine.catch(() => engines.delete(directory));
    }
    return engine;
  }
  async function getRecord(owner, id, root) {
    if (typeof owner !== "string" || !owner || !workbenchId(id)) throw new Error("Unknown molecular workbench.");
    const directory = join(makeDirectory(owner), id);
    const record = JSON.parse(await readFile(join(directory, "viewer.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") throw new Error("Unknown molecular workbench.");
      throw error;
    }));
    if (record.owner !== owner || record.id !== id || root && record.root !== root) {
      throw new Error("Unknown molecular workbench.");
    }
    return { record, directory };
  }
  async function activate(record) {
    const current = { id: record.id, title: record.title };
    latest.set(record.owner, current);
    await writePrivateJson(makeDirectory(record.owner), "latest.json", current);
  }
  function activeRecord(owner) {
    let current = latest.get(owner);
    if (!current) {
      try {
        current = JSON.parse(readFileSync(join(makeDirectory(owner), "latest.json"), "utf8"));
        latest.set(owner, current);
      } catch {
        return void 0;
      }
    }
    return current;
  }
  async function listRecords(owner, root) {
    const ownerDirectory = makeDirectory(owner);
    const files = await readdir(ownerDirectory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records = await Promise.all(files.filter(workbenchId).map((id) => getRecord(owner, id, root).catch(() => null)));
    return records.filter(Boolean).sort((left, right) => right.record.openedAt - left.record.openedAt);
  }
  async function openWorkbench(owner, root, input, signal, previewAddress) {
    const { path } = input;
    const id = randomUUID();
    const directory = join(makeDirectory(owner), id);
    const args = {
      ...path ? { path } : { exampleId: input.exampleId },
      openIntentId: randomUUID()
    };
    await mkdir(directory, { recursive: true, mode: 448 });
    try {
      const engine = await engineFor(directory, root);
      const presentation = await engine.call("structure.open_from_chat", args, signal);
      const sessionId = presentation.structuredContent?.viewerSessionId;
      const template = presentation._meta?.["openai/outputTemplate"];
      if (presentation.isError || !sessionId || !template) {
        throw new Error(publicResult("open", presentation).summary);
      }
      const record = {
        id,
        owner,
        root,
        openedAt: Date.now(),
        sessionId,
        template,
        presentation,
        args,
        previewAddress,
        title: path ? basename(path) : "Green fluorescent protein (1EMA)",
        placement: input.placement ?? "inline"
      };
      await writePrivateJson(directory, "viewer.json", record);
      await activate(record);
      return record;
    } catch (error) {
      const engine = engines.get(directory);
      engines.delete(directory);
      await (await engine?.catch(() => null))?.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  function requireWorkspaceWrite(agent) {
    const policy = ctx.sandboxPolicy.resolve({ session: agent.session });
    if (policy.mode === "read-only") throw new Error("The DSH session is read-only. This operation writes a workspace artifact.");
  }
  async function prepareSource(root, args) {
    if (Boolean(args.source) === Boolean(args.exampleId)) {
      throw new Error("Supply one workspace source file or exampleId.");
    }
    if (args.exampleId) return { key: JSON.stringify(["example", args.exampleId]) };
    const imported = importSource(args.source.trim());
    const hasLocalAccessionFile = imported?.name && imported.url && await stat(resolve(root, args.source)).then((info2) => info2.isFile(), () => false);
    if (imported && !hasLocalAccessionFile) {
      const address = imported.url ? new URL(imported.url).href : imported.text;
      return { imported, key: createHash("sha256").update(address).digest("hex") };
    }
    const path = await sourcePath(root, args.source);
    const info = await stat(path, { bigint: true });
    const version = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    return { path, key: JSON.stringify(["file", path, version]) };
  }
  async function createAgentWorkbench(agent, root, args, source, signal) {
    if (!source.imported) return openWorkbench(agent.id, root, { ...args, path: source.path }, signal);
    requireWorkspaceWrite(agent);
    const { file, directory } = await importStructure(root, source.imported, signal);
    try {
      return await openWorkbench(agent.id, root, { ...args, path: await sourcePath(root, file) }, signal);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async function openForAgent(agent, root, args, turn, signal) {
    signal?.throwIfAborted();
    const source = await prepareSource(root, args);
    signal?.throwIfAborted();
    let requests = openRequests.get(agent.session);
    if (!requests || requests.turn !== turn) {
      requests = { turn, pending: /* @__PURE__ */ new Map() };
      openRequests.set(agent.session, requests);
    }
    const key = JSON.stringify([root, source.key]);
    const pending = requests.pending;
    while (pending.has(key)) {
      signal?.throwIfAborted();
      const previous = pending.get(key);
      const record = await previous.catch(() => null);
      signal?.throwIfAborted();
      if (record) return { record, reused: true };
      if (pending.get(key) === previous) pending.delete(key);
    }
    signal?.throwIfAborted();
    const opening = createAgentWorkbench(agent, root, args, source, signal);
    pending.set(key, opening);
    try {
      return { record: await opening, reused: false };
    } catch (error) {
      if (pending.get(key) === opening) pending.delete(key);
      throw error;
    } finally {
      if (turn === void 0 && pending.get(key) === opening) pending.delete(key);
    }
  }
  async function operationHelp(args, root) {
    const catalog = await engineFor(join(profileDirectory(), "catalog"), root);
    const operations = [...catalog.tools.values()].filter((item2) => visibleTo(item2, "model") && !blockedOpen.has(item2.name));
    if (args.action === "operations") {
      return {
        ok: true,
        action: args.action,
        summary: "Molecular workbench operations.",
        data: { operations: operations.map(({ name }) => name) }
      };
    }
    const item = requireOperation(catalog, args.operation);
    const schema = structuredClone(item.inputSchema);
    if (schema.properties) delete schema.properties.sessionId;
    if (schema.required) schema.required = schema.required.filter((key) => key !== "sessionId");
    return {
      ok: true,
      action: args.action,
      summary: item.description ?? item.name,
      data: { name: item.name, inputSchema: schema }
    };
  }
  function requireOperation(engine, operation) {
    if (blockedOpen.has(operation)) {
      throw new Error('Use action "open" with a source or exampleId to open a molecular structure.');
    }
    const item = engine.tools.get(operation);
    if (!visibleTo(item, "model")) {
      throw new Error(`Unknown operation ${JSON.stringify(operation)}. Use action "operations" to list supported operations.`);
    }
    return item;
  }
  async function execute(args, exec) {
    const agent = exec.agent;
    if (!agent) throw new Error("Open the molecular workbench from a DSH conversation.");
    const owner = agent.id;
    const turn = turns.get(agent.session);
    const root = await resolveRoot(agent, exec.signal);
    if (args.action === "operations" || args.action === "help") return operationHelp(args, root);
    if (args.action === "open") {
      const { record, reused } = await openForAgent(agent, root, args, turn, exec.signal);
      return {
        ok: true,
        action: args.action,
        summary: reused ? `Reusing the workbench for ${record.title} opened in this turn.` : `Opened ${record.title} in the Molecular Structure Workbench.`,
        data: { viewerId: record.id, title: record.title, placement: record.placement, reused },
        ...reused ? {} : { scene: scene(record, turn) }
      };
    }
    const listViewers = args.action === "viewers" || args.operation === "structure.list_viewers";
    const records = args.viewerId !== void 0 && !listViewers ? [await getRecord(owner, args.viewerId, root)] : await listRecords(owner, root);
    if (listViewers) {
      return {
        ok: true,
        action: args.action,
        summary: "Molecular workbenches in this DSH conversation.",
        data: { viewers: records.map(({ record }) => ({
          viewerId: record.id,
          title: record.title,
          placement: record.placement,
          openedAt: record.openedAt
        })) }
      };
    }
    const active = activeRecord(owner);
    const current = records.find((item) => item.record.id === active?.id) ?? records[0];
    if (!current) throw new Error("Open a molecular workbench first.");
    const engine = await engineFor(current.directory, root);
    const { operation } = args;
    requireOperation(engine, operation);
    const input = args.arguments ?? (args.action === "context" ? { sections: ["overview", "selection", "annotations", "results"] } : {});
    if (publishingOperations.has(operation) || operation === "structure.project" && input.action === "save") {
      requireWorkspaceWrite(agent);
    }
    return publicResult(args.action, await runForViewer(engine, current.record, current.directory, operation, input, exec.signal));
  }
  async function openPreview(input, signal) {
    const agent = typeof input.sessionId === "string" && ctx.agents.get(input.sessionId);
    if (!agent || typeof input.address !== "string") throw new Error("Open the file from a DSH conversation.");
    const address = new URL(input.address);
    const prefix = `/session/${encodeURIComponent(agent.id)}/`;
    if (address.protocol !== "dsh-resource:" || address.hostname !== "file" || !address.pathname.startsWith(prefix)) {
      throw new Error("This file address does not belong to the current DSH conversation.");
    }
    const source = address.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    const root = await resolveRoot(agent, signal);
    const path = await sourcePath(root, source);
    const identity = `${agent.id}\0${path}`;
    let pending = previewOpens.get(identity);
    if (!pending) {
      pending = (async () => {
        const { version } = await ctx.workspaceFiles.stat({ sessionId: agent.id, workspaceRoot: root }, path, signal);
        const previewAddress = `${path}\0${version}`;
        const previous = (await listRecords(agent.id, root)).find((item) => item.record.previewAddress === previewAddress);
        const record = previous?.record ?? await openWorkbench(agent.id, root, { path, placement: "sidebar" }, void 0, previewAddress);
        if (previous) await activate(record);
        return { scene: scene(record), version };
      })();
      previewOpens.set(identity, pending);
      void pending.finally(() => previewOpens.delete(identity)).catch(() => {
      });
    }
    return pending;
  }
  ctx.tools.register({
    ...tool,
    execute: async (value, exec) => {
      let action = "invalid_input";
      try {
        const args = normalizeToolCall(value);
        action = args.action;
        return await execute(args, exec);
      } catch (error) {
        return { ok: false, action, summary: errorText(error) };
      }
    }
  });
  ctx.effect(() => ctx.systemPrompt.section({
    name: "molecular-workbench:live-context",
    order: 8501,
    text: (context) => {
      if (!context.agent) return "";
      const current = activeRecord(context.agent.id);
      if (!current) return "";
      return `A live Mol* Molecular Structure Workbench is available in this DSH conversation. For questions about the user's current selection or measurements, call molecular_workbench with action=context. The active workbench is ${JSON.stringify(current.title)} (viewerId ${current.id}).`;
    }
  }));
  ctx.effect(() => {
    const disposeResources = ctx.webServer.register({
      kind: "prefix",
      path: WORKBENCH_ROUTE,
      resource: async (request2, peer) => {
        try {
          const rejection = peer ? void 0 : ctx.connection.requestRejection(request2);
          if (rejection !== void 0) return json({ error: "Open the workbench in an authenticated DSH session." }, rejection);
          const parts = new URL(request2.url).pathname.slice(WORKBENCH_ROUTE.length + 1).split("/");
          if (parts.length !== 3) return json({ error: "Unknown molecular workbench route." }, 404);
          const [session, id, action] = parts;
          const { record, directory } = await getRecord(decodeURIComponent(session), id);
          const engine = await engineFor(directory, record.root);
          if (action === "setup" && request2.method === "GET") {
            const { path, ...publicArgs } = record.args;
            return json({ args: publicArgs, result: record.presentation, lastDistance: (await readLastDistance(directory))?.measurement });
          }
          if (action === "frame" && request2.method === "GET") {
            const resources = await engine.request("resources/read", { uri: record.template }, request2.signal);
            return new Response(resources.contents[0].text, {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "content-security-policy": CSP,
                "referrer-policy": "no-referrer",
                "x-content-type-options": "nosniff"
              }
            });
          }
          return json({ error: "Unknown molecular workbench route." }, 404);
        } catch (error) {
          return json({ error: errorText(error) }, 400);
        }
      }
    });
    const disposeApi = ctx.webServer.register({
      kind: "exact",
      path: `${WORKBENCH_ROUTE}/api`,
      handler: async (request2, response) => {
        const abort = new AbortController();
        response.once("close", () => abort.abort());
        async function run() {
          const rejection = ctx.connection.requestRejection(request2);
          if (rejection !== void 0) return json({ error: "Open the workbench in an authenticated DSH session." }, rejection);
          if (request2.method !== "POST") return json({ error: "Use POST." }, 405);
          const { action, sessionId, viewerId, address, method, params, picks } = await parseBody(request2);
          if (action === "preview") return json(await openPreview({ sessionId, address }, abort.signal));
          const { record, directory } = await getRecord(sessionId, viewerId);
          if (action === "activate") {
            if (activeRecord(sessionId)?.id !== viewerId) await activate(record);
            return json({ ok: true });
          }
          const engine = await engineFor(directory, record.root);
          if (action === "selected-residue") return json({ residue: await selectedResidue(engine, record, abort.signal) });
          if (action === "residue-distance") {
            if (!Array.isArray(picks) || picks.length !== 2 || !picks[0]?.objectId || picks[0].objectId !== picks[1]?.objectId) {
              throw new Error("Choose two residues from the same loaded structure.");
            }
            const [first, second] = picks;
            if (first.id === second.id) throw new Error("Choose two distinct residues.");
            if (activeRecord(sessionId)?.id !== viewerId) await activate(record);
            const result2 = await runForViewer(engine, record, directory, "structure.control_viewer", {
              action: "measure_residue_distance",
              objectId: first.objectId,
              chain: first.chain,
              residue: first.residueNumber,
              insertionCode: first.insertionCode,
              instanceId: first.instanceId,
              chainB: second.chain,
              residueB: second.residueNumber,
              insertionCodeB: second.insertionCode,
              instanceIdB: second.instanceId
            }, abort.signal);
            const measured = publicResult("residue-distance", result2);
            return measured.ok ? json(measured) : json({ error: measured.summary }, 400);
          }
          if (action !== "rpc") return json({ error: "Unknown molecular workbench operation." }, 400);
          if (method === "tools/call" && visibleTo(engine.tools.get(params?.name), "app") && !blockedOpen.has(params.name)) {
            return json({ result: await engine.request(method, params, abort.signal) });
          }
          if (method === "resources/read" && typeof params?.uri === "string") {
            return json({ result: await engine.request(method, params, abort.signal) });
          }
          return json({ error: "Unknown molecular workbench renderer operation." }, 400);
        }
        const result = await run().catch((error) => json({ error: errorText(error) }, 400));
        if (!abort.signal.aborted) {
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.end(await result.text());
        }
      }
    });
    return () => {
      disposeApi();
      disposeResources();
      for (const engine of engines.values()) void engine.then((item) => item.close()).catch(() => {
      });
      engines.clear();
    };
  });
}

// src/index.js
var inject = ["tools", "webServer", "connection", "systemPrompt", "workingDirectory", "agents", "workspaceFiles", "sandboxPolicy"];
function apply(ctx) {
  const turns = /* @__PURE__ */ new WeakMap();
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/start") turns.set(session, event.data.turn);
    if (event.type === "turn/end") turns.delete(session);
  }, { global: true });
  registerWorkbench(ctx, turns);
}
export {
  apply,
  inject
};
