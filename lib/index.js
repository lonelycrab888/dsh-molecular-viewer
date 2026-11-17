// src/workbench.js
import { createHash as createHash2, randomUUID } from "node:crypto";
import { readFileSync as readFileSync2 } from "node:fs";
import { lstat as lstat2, mkdir as mkdir2, mkdtemp as mkdtemp2, readFile as readFile2, readdir, realpath as realpath2, rename, rm as rm2, stat, writeFile as writeFile2 } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join as join2, relative, resolve, sep } from "node:path";

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

// src/starter-examples.js
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
var exampleDirectory = new URL("../vendor/structure-viewer/examples/", import.meta.url);
var contract = JSON.parse(readFileSync(new URL("starter-examples.json", exampleDirectory), "utf8"));
var starters = new Map(contract.examples.map((example) => [example.id, example]));
async function prepareStarter(root, starter, signal) {
  const inputs = await Promise.all(starter.sources.map(async (source) => {
    const bytes = await readFile(new URL(`${source.accession}.pdb`, exampleDirectory), { signal });
    const digest = createHash("sha256").update(bytes).digest("hex");
    const atomCount = bytes.toString("ascii").match(/^(?:ATOM  |HETATM)/gm)?.length ?? 0;
    if (digest !== source.sha256 || bytes.length !== source.byteLength || atomCount !== source.atomCount) {
      throw new Error(`Bundled source drift for ${source.accession} (expected PDB revision ${source.revision.date}).`);
    }
    return { name: `${source.accession}.pdb`, bytes };
  }));
  const base = join(root, "structure-viewer-examples");
  await mkdir(base, { mode: 448 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await lstat(base)).isDirectory() || await realpath(base) !== base) {
    throw new Error("The examples directory must be inside the local workspace.");
  }
  const directory = await mkdtemp(join(base, `${starter.id}-`));
  try {
    for (const input of inputs) {
      await writeFile(join(directory, input.name), input.bytes, { flag: "wx", mode: 384, signal });
    }
    if (starter.id === "gfp-publication-image") await mkdir(join(directory, "structure-viewer"), { mode: 448 });
    return { directory, path: join(directory, inputs[0].name) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
function bind(value, bindings) {
  if (typeof value === "string" && value.startsWith("$")) {
    if (Object.hasOwn(bindings, value)) return bindings[value];
    if (value.startsWith("$WORKSPACE/")) return join(bindings.$WORKSPACE, value.slice(11));
    throw new Error(`Missing starter result binding ${value}.`);
  }
  if (Array.isArray(value)) return value.map((item) => bind(item, bindings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item, bindings)]));
  }
  return value;
}
async function runStarter(starter, { workspace, sessionId, engine, signal, progress }) {
  const bindings = { $WORKSPACE: workspace, $VIEWER_SESSION_ID: sessionId };
  const completed = [];
  for (const step of starter.orderedToolSequence.slice(1)) {
    signal?.throwIfAborted();
    await progress(step);
    const result = await engine.call(step.tool, bind(step.request, bindings), signal);
    const summary = result.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
    const data = result.structuredContent;
    if (result.isError || data?.applied === false || step.tool === "structure.render_image" && data?.status !== "completed") {
      throw new Error(summary || `Starter failed in ${step.tool}.`);
    }
    for (const [field, name] of Object.entries(step.resultBindings ?? {})) {
      const resolved = field.split(".").reduce((record, key) => record?.[key], result);
      if (resolved !== void 0) bindings[name] = resolved;
    }
    if (step.tool === "structure.analyze" || step.tool === "structure.align_structures" || step.tool === "structure.render_image") {
      const state = data?.state;
      completed.push({
        tool: step.tool,
        summary,
        data: state?.analysis ?? state?.alignment ?? data?.result ?? {}
      });
    }
  }
  return completed;
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
var workbenchActions = /* @__PURE__ */ new Set(["open", "viewers", "status", "context", "operations", "help", "run", "examples"]);
var shorthandOperations = /* @__PURE__ */ new Map([
  ["status", "structure.get_viewer_status"],
  ["context", "structure.get_context"]
]);
var openIntentUuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
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
  return resolve(process.env.DSH_HOME || join2(homedir(), ".dsh"), "cache", "dsh-molecular-workbench");
}
function containsPath(root, absolutePath) {
  const portion = relative(root, absolutePath);
  return portion !== ".." && !portion.startsWith(`..${sep}`) && !isAbsolute(portion);
}
async function sourcePath(root, address) {
  const file = await realpath2(resolve(root, address));
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
  const base = join2(root, ".dsh-molecular-sources");
  await mkdir2(base, { mode: 448 }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (!(await lstat2(base)).isDirectory() || await realpath2(base) !== base) {
    throw new Error("The molecular source directory must be a local workspace directory.");
  }
  const directory = await mkdtemp2(join2(base, "source-"));
  try {
    const file = join2(directory, name);
    await writeFile2(file, bytes, { flag: "wx", mode: 384, signal });
    return { file, directory };
  } catch (error) {
    await rm2(directory, { recursive: true, force: true });
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
    deliveredAt: record.deliveredAt ?? record.openedAt,
    ...record.starterId ? { starterId: record.starterId } : {},
    ...turn === void 0 ? {} : { turn }
  };
}
function makeDirectory(owner) {
  return join2(profileDirectory(), createHash2("sha256").update(owner).digest("hex"));
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
  const temporary = join2(directory, `record-${randomUUID()}.tmp`);
  try {
    await writeFile2(temporary, JSON.stringify(value), { mode: 384, flag: "wx" });
    await rename(temporary, join2(directory, file));
  } finally {
    await rm2(temporary, { force: true });
  }
}
async function readLastDistance(directory) {
  try {
    return JSON.parse(await readFile2(join2(directory, "last-distance.json"), "utf8"));
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
    "Repeated opens of the same unchanged source in the same conversation reuse its workbench. Use reopen with a fresh openIntentId for a separate viewer. Use status to confirm the renderer is ready before scene operations. Reuse its viewerId for comparison, scientific analysis and rendering.",
    "Use context after the user selects or measures something in the viewer. Prefer this tool for new interactive visualizations.",
    'Use action "operations" to list operations or action "help" with an operation name to obtain its input schema. Both work before opening a viewer.',
    'Use action examples to list packaged starters. Pass a starter exampleId to open and run it in one workbench. For example, inspect a live viewer with {"action":"run","operation":"structure.get_state"}. The operation name can also be passed as action, or by itself in operation.',
    "For revision-guarded operations, read structure.get_state first. Pass a DSH viewerId only when targeting a specific viewer."
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: { type: "string", description: "open, viewers, status, context, operations, help, run, or examples. Also accepts a structure.* operation name as a shortcut." },
      source: { type: "string", description: "A workspace file, RCSB PDB ID, public HTTPS URL, or inline PDB/mmCIF text." },
      exampleId: { type: "string", description: "Use gfp-1ema for the bundled structure. Use action examples for the three guided workflows." },
      viewerId: { type: "string", description: "DSH viewer ID from open or viewers. Defaults to the active viewer." },
      placement: { type: "string", enum: ["inline", "sidebar"], description: "Initial location for a newly opened viewer. Defaults to inline." },
      openIntentId: { type: "string", description: "Optional UUID for the open request. Reuse it for retries." },
      reopen: { type: "boolean", description: "Create a separate workbench with a fresh openIntentId." },
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
  const openRequests = /* @__PURE__ */ new Map();
  const starterRuns = /* @__PURE__ */ new Map();
  const renderers = /* @__PURE__ */ new Map();
  const latest = /* @__PURE__ */ new Map();
  async function resolveRoot(agent, signal) {
    return realpath2(await ctx.workingDirectory.ensure(agent, signal));
  }
  function engineFor(directory, root) {
    let engine = engines.get(directory);
    if (!engine) {
      engine = connectWorkbench(root, join2(directory, "engine"));
      engines.set(directory, engine);
      engine.catch(() => engines.delete(directory));
    }
    return engine;
  }
  async function readPrivateJson(directory, file) {
    return readFile2(join2(directory, file), "utf8").then(JSON.parse, (error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
  }
  async function getRecord(owner, id, root) {
    if (typeof owner !== "string" || !owner || !workbenchId(id)) throw new Error("Unknown molecular workbench.");
    const directory = join2(makeDirectory(owner), id);
    const record = JSON.parse(await readFile2(join2(directory, "viewer.json"), "utf8").catch((error) => {
      if (error.code === "ENOENT") throw new Error("Unknown molecular workbench.");
      throw error;
    }));
    if (record.owner !== owner || record.id !== id || root && record.root !== root) {
      throw new Error("Unknown molecular workbench.");
    }
    const location = await readPrivateJson(directory, "placement.json");
    if (location) record.placement = location.placement;
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
        current = JSON.parse(readFileSync2(join2(makeDirectory(owner), "latest.json"), "utf8"));
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
    const directory = join2(makeDirectory(owner), id);
    const args = {
      ...path ? { path } : { exampleId: input.exampleId },
      openIntentId: input.openIntentId ?? randomUUID()
    };
    await mkdir2(directory, { recursive: true, mode: 448 });
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
        sourceKey: input.sourceKey,
        starterId: input.starterId,
        cardTurn: input.cardTurn,
        title: starters.get(input.starterId)?.title ?? (path ? basename(path) : "Green fluorescent protein (1EMA)"),
        placement: input.placement ?? "inline"
      };
      await writePrivateJson(directory, "viewer.json", record);
      await activate(record);
      return record;
    } catch (error) {
      const engine = engines.get(directory);
      engines.delete(directory);
      await (await engine?.catch(() => null))?.close();
      await rm2(directory, { recursive: true, force: true });
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
    if (args.exampleId) {
      return { key: JSON.stringify(["example", args.exampleId]), starter: starters.get(args.exampleId) };
    }
    const imported = importSource(args.source.trim());
    const hasLocalAccessionFile = imported?.name && imported.url && await stat(resolve(root, args.source)).then((info2) => info2.isFile(), () => false);
    if (imported && !hasLocalAccessionFile) {
      const address = imported.url ? new URL(imported.url).href : imported.text;
      return { imported, key: createHash2("sha256").update(address).digest("hex") };
    }
    const path = await sourcePath(root, args.source);
    const info = await stat(path, { bigint: true });
    const version = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
    return { path, modifiedAt: Number(info.ctimeMs), key: JSON.stringify(["file", path, version]) };
  }
  async function createAgentWorkbench(agent, root, args, source, turn, signal) {
    const input = { ...args, path: source.path, sourceKey: source.key, cardTurn: turn };
    if (!source.imported && !source.starter) return openWorkbench(agent.id, root, input, signal);
    requireWorkspaceWrite(agent);
    const prepared = source.starter ? await prepareStarter(root, source.starter, signal) : await importStructure(root, source.imported, signal);
    try {
      return await openWorkbench(agent.id, root, {
        ...input,
        path: await sourcePath(root, prepared.path ?? prepared.file),
        starterId: source.starter?.id
      }, signal);
    } catch (error) {
      await rm2(prepared.directory, { recursive: true, force: true });
      throw error;
    }
  }
  function matchesSource(record, source, args) {
    if (record.sourceKey) return record.sourceKey === source.key;
    if (source.path) return record.args.path === source.path && source.modifiedAt <= record.openedAt;
    return !!args.exampleId && record.args.exampleId === args.exampleId;
  }
  function viewerLifecycle(record, state) {
    const renderer = renderers.get(record.id);
    const pending = renderer && (!renderer.attached || state?.rendererIncarnationId === renderer.previousIncarnation);
    const mounted = !pending && state?.mounted?.status === "mounted" && state.mounted.hydrated === true;
    const renderState = pending ? "pending" : state?.rendered?.status ?? "pending";
    return {
      viewerReady: mounted && renderState === "ready",
      mountState: mounted ? "mounted" : "mount-pending",
      renderState
    };
  }
  async function readiness(engine, record, signal) {
    const result = await callForViewer(engine, record, "structure.get_viewer_status", {}, signal);
    return viewerLifecycle(record, result.isError ? void 0 : result.structuredContent);
  }
  async function openForAgent(agent, root, args, turn, signal) {
    signal?.throwIfAborted();
    const intent = args.openIntentId?.toLowerCase();
    if (intent !== void 0 && !openIntentUuid.test(intent)) throw new Error("openIntentId must be a UUID.");
    if (args.reopen && !intent) throw new Error("Supply a fresh openIntentId UUID when reopen is true.");
    const source = await prepareSource(root, args);
    const lock = JSON.stringify([agent.id, root]);
    const waiting = openRequests.get(lock);
    const task = (async () => {
      await waiting?.catch(() => {
      });
      signal?.throwIfAborted();
      const records = (await listRecords(agent.id, root)).filter(({ record: record2 }) => !record2.previewAddress);
      const replay = intent && records.find(({ record: record2 }) => record2.args.openIntentId === intent || record2.openIntentAliases?.includes(intent));
      if (replay && !matchesSource(replay.record, source, args)) {
        throw new Error("This openIntentId belongs to another source or file revision. Use a new UUID.");
      }
      const existing = replay || !args.reopen && records.find(({ record: record2 }) => matchesSource(record2, source, args));
      if (existing) {
        const { record: record2, directory } = existing;
        const engine = await engineFor(directory, root);
        const live = await readiness(engine, record2, signal);
        const present = !live.viewerReady && record2.cardTurn !== turn;
        if (intent && record2.args.openIntentId !== intent && !record2.openIntentAliases?.includes(intent)) {
          record2.openIntentAliases = [...record2.openIntentAliases ?? [], intent];
        }
        if (present) {
          record2.cardTurn = turn;
          record2.deliveredAt = Math.max(Date.now(), (record2.deliveredAt ?? record2.openedAt) + 1);
        }
        record2.sourceKey = source.key;
        await writePrivateJson(directory, "viewer.json", record2);
        await activate(record2);
        return { record: record2, reused: true, present, live };
      }
      const record = await createAgentWorkbench(agent, root, { ...args, openIntentId: intent }, source, turn, signal);
      return { record, reused: false, present: true, live: {
        viewerReady: false,
        mountState: "presentation-issued",
        renderState: "pending"
      } };
    })();
    openRequests.set(lock, task);
    try {
      return await task;
    } finally {
      if (openRequests.get(lock) === task) openRequests.delete(lock);
    }
  }
  async function starterStatus(directory) {
    return starterRuns.get(directory)?.state ?? await readPrivateJson(directory, "starter-result.json") ?? { phase: "pending" };
  }
  async function maybeStartExample(engine, record, directory, live) {
    const existing = await starterStatus(directory);
    if (!live.viewerReady || existing.phase !== "pending" || starterRuns.has(directory)) return existing;
    const starter = starters.get(record.starterId);
    if (!starter) throw new Error("The starter definition is unavailable.");
    const controller = new AbortController();
    const task = { controller, state: { phase: "running", step: 1, total: starter.orderedToolSequence.length } };
    starterRuns.set(directory, task);
    void runStarter(starter, {
      workspace: dirname(record.args.path),
      sessionId: record.sessionId,
      engine,
      signal: controller.signal,
      progress: (step) => {
        task.state = { ...task.state, step: step.order, operation: step.tool };
      }
    }).then(
      (results) => {
        task.state = { phase: "complete", results };
      },
      (error) => {
        task.state = { phase: "error", error: errorText(error), step: task.state.step };
      }
    ).then(() => writePrivateJson(directory, "starter-result.json", task.state)).then(() => starterRuns.delete(directory)).catch((error) => {
      task.state = { phase: "error", error: errorText(error) };
    });
    return task.state;
  }
  async function askAboutSelection(engine, record, question, signal) {
    if (typeof question !== "string" || !question.trim() || question.length > 1e3) {
      throw new Error("Enter a question of up to 1,000 characters.");
    }
    const agent = ctx.agents.get(record.owner);
    if (!agent || await resolveRoot(agent, signal) !== record.root) {
      throw new Error("Open the owning DSH conversation before asking about a selection.");
    }
    const result = await callForViewer(engine, record, "structure.get_context", {
      sections: ["selection"],
      maxItems: 16,
      maxBytes: 8192
    }, signal);
    const selected = result.structuredContent?.sections?.selection?.selected;
    if (result.isError || !selected?.atomCount) throw new Error("Select a residue, chain, or atom in this workbench first.");
    const snapshot = {
      viewerId: record.id,
      structure: record.title,
      revision: result.structuredContent.revision,
      summary: selected.summary,
      expression: selected.expression,
      atomCount: selected.atomCount
    };
    await activate(record);
    signal?.throwIfAborted();
    agent.followup({
      id: randomUUID(),
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: `${question.trim()}

DSH molecular workbench selection at the time of this question:
${JSON.stringify(snapshot)}` }]
    });
  }
  async function operationHelp(args, root) {
    const catalog = await engineFor(join2(profileDirectory(), "catalog"), root);
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
    if (args.action === "examples") return {
      ok: true,
      action: args.action,
      summary: "Molecular workbench starter examples.",
      data: { examples: [...starters.values()].map(({ id, title, prompt }) => ({ id, title, prompt })) }
    };
    if (args.action === "open") {
      const { record, reused, present, live } = await openForAgent(agent, root, args, turn, exec.signal);
      return {
        ok: true,
        action: args.action,
        summary: `${reused ? "Reusing" : "Opening"} ${record.title} in the Molecular Structure Workbench. ${live.viewerReady ? "The viewer is ready." : "Wait for the renderer and check status before controlling the scene."}`,
        data: {
          viewerId: record.id,
          title: record.title,
          placement: record.placement,
          reused,
          sessionReady: true,
          viewerReady: live.viewerReady,
          viewerOpen: {
            disposition: reused ? "reused" : "created",
            intentId: args.openIntentId ?? record.args.openIntentId,
            mountState: live.mountState,
            renderState: live.renderState
          },
          ...record.starterId ? { starterId: record.starterId } : {}
        },
        ...present ? { scene: scene(record, turn) } : {}
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
    const result = await runForViewer(engine, current.record, current.directory, operation, input, exec.signal);
    const reply = publicResult(args.action, result);
    if (reply.ok && operation === "structure.get_viewer_status") {
      reply.data = { ...reply.data, ...viewerLifecycle(current.record, reply.data) };
    }
    if (reply.ok && current.record.starterId && (operation === "structure.get_viewer_status" || operation === "structure.get_context")) {
      reply.data = { ...reply.data, starter: await starterStatus(current.directory) };
    }
    return reply;
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
          if (action === "location" && request2.method === "GET") return json({ placement: record.placement });
          if (action === "setup" && request2.method === "GET") {
            const { path, ...publicArgs } = record.args;
            return json({
              args: publicArgs,
              result: record.presentation,
              lastDistance: (await readLastDistance(directory))?.measurement,
              examples: [...starters.values()].map(({ id: id2, title }) => ({ id: id2, title }))
            });
          }
          if (action === "frame" && request2.method === "GET") {
            const engine = await engineFor(directory, record.root);
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
          const { action, sessionId, viewerId, address, method, params, picks, question, placement, exampleId, token } = await parseBody(request2);
          if (action === "preview") return json(await openPreview({ sessionId, address }, abort.signal));
          const { record, directory } = await getRecord(sessionId, viewerId);
          if (action === "activate") {
            if (activeRecord(sessionId)?.id !== viewerId) await activate(record);
            return json({ ok: true });
          }
          if (action === "placement") {
            if (placement !== "inline" && placement !== "sidebar") throw new Error("Unknown workbench placement.");
            await writePrivateJson(directory, "placement.json", { placement });
            return json({ ok: true });
          }
          if (action === "detach-renderer") {
            const renderer = renderers.get(record.id);
            if (renderer?.token === token) renderer.attached = false;
            return json({ ok: true });
          }
          const engine = await engineFor(directory, record.root);
          if (action === "attach-renderer") {
            if (typeof token !== "string" || !openIntentUuid.test(token)) throw new Error("Invalid renderer ID.");
            const renderer = { token, attached: true, previousIncarnation: null };
            renderers.set(record.id, renderer);
            const result2 = await callForViewer(engine, record, "structure.get_viewer_status", {}, abort.signal);
            renderer.previousIncarnation = result2.structuredContent?.rendererIncarnationId ?? null;
            return json({ ok: true });
          }
          if (action === "status") {
            const result2 = await callForViewer(engine, record, "structure.get_viewer_status", {}, abort.signal);
            if (result2.isError) throw new Error(publicResult("status", result2).summary);
            const state = result2.structuredContent;
            const live = viewerLifecycle(record, state);
            const starter = record.starterId ? await maybeStartExample(engine, record, directory, live) : void 0;
            const publicStarter = starter?.phase === "complete" ? {
              phase: "complete",
              results: starter.results.map(({ tool: tool2, summary }) => ({ tool: tool2, summary }))
            } : starter;
            return json({ state, ...live, starter: publicStarter });
          }
          if (action === "launch-example") {
            const starter = starters.get(exampleId);
            const agent = ctx.agents.get(record.owner);
            if (!starter || !agent || await resolveRoot(agent, abort.signal) !== record.root) {
              throw new Error("Open the owning DSH conversation before starting a packaged example.");
            }
            abort.signal.throwIfAborted();
            agent.followup({
              id: randomUUID(),
              role: "user",
              source: { kind: "user" },
              content: [{ type: "text", text: `${starter.prompt}

Run the packaged DSH starter with molecular_workbench action "open" and exampleId "${starter.id}". The workbench runs the example after mounting.` }]
            });
            return json({ ok: true });
          }
          if (action === "ask-selection") {
            await askAboutSelection(engine, record, question, abort.signal);
            return json({ ok: true });
          }
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
      for (const task of starterRuns.values()) task.controller.abort();
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
