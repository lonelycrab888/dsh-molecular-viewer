// src/index.js
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir as mkdir2, open, rename as rename2, rm as rm2, stat as stat2, writeFile as writeFile2 } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { basename as basename2, extname, isAbsolute as isAbsolute2, join as join2, resolve as resolve2 } from "node:path";
import { Readable } from "node:stream";

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
  return new Promise((resolve3, reject) => {
    const req = request(url, {
      agent: false,
      family: endpoint.family,
      lookup: (_host, _options, callback) => callback(null, endpoint.address, endpoint.family),
      headers: { "user-agent": "DSH-Molecular-Viewer (DeepSeek Harness plugin)" },
      signal
    }, resolve3);
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
async function readStructureText(stream, length) {
  return (await readStructureBytes(stream, length)).toString("utf8");
}
async function downloadStructure(input, signal, label) {
  const { bytes, url } = await downloadStructureBytes(input, signal, label);
  return { text: bytes.toString("utf8"), url };
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

// src/residue.js
function residueKey(residue) {
  return JSON.stringify([
    residue.chain,
    residue.labelChain,
    residue.numbering,
    residue.number,
    residue.insertionCode,
    residue.name,
    residue.modelNumber,
    residue.number === null ? residue.atomIndex : null
  ]);
}
function token(value, limit, allowEmpty = false) {
  if (typeof value !== "string" || value.length > limit || !allowEmpty && !value || /[^!-~]/.test(value)) {
    throw new Error("Invalid residue selection.");
  }
  return value;
}
function integer(value, minimum = Number.MIN_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("Invalid residue selection.");
  return value;
}
function normalizePickedResidue(value) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || value.numbering !== "author" && value.numbering !== "label") {
    throw new Error("Invalid residue selection.");
  }
  return {
    chain: token(value.chain, 32, true),
    labelChain: token(value.labelChain, 32, true),
    numbering: value.numbering,
    number: value.number === null ? null : integer(value.number),
    insertionCode: token(value.insertionCode, 4, true),
    name: token(value.name, 16),
    modelNumber: value.modelNumber === null ? null : integer(value.modelNumber, 1),
    atomIndex: integer(value.atomIndex, 0),
    atomName: token(value.atomName, 24, true),
    element: token(value.element, 4, true),
    atomCount: integer(value.atomCount, 1),
    bFactor: Number.isFinite(value.bFactor) ? value.bFactor : null
  };
}
function residueIdentityText(residue) {
  const position = residue.number === null ? "unassigned residue number" : `${residue.number}${residue.insertionCode}`;
  const chain = residue.chain === "" ? "blank chain ID" : `chain ${JSON.stringify(residue.chain)}`;
  const labelChain = residue.labelChain && residue.labelChain !== residue.chain ? `, label chain ${JSON.stringify(residue.labelChain)}` : "";
  const model = residue.modelNumber === null ? "" : `, model ${residue.modelNumber}`;
  return `${chain}${labelChain}, ${JSON.stringify(residue.name)} ${position} (${residue.numbering} numbering)${model}`;
}
function pickedResidueText(residue) {
  const atom = residue.atomName ? `, clicked atom ${JSON.stringify(residue.atomName)}` : "";
  return residueIdentityText(residue) + atom;
}

// src/measurement.js
var NON_HEAVY_ELEMENTS = /* @__PURE__ */ new Set(["", "H", "D", "T", "X", "XX", "DU"]);
function isHeavyElement(element) {
  return typeof element === "string" && /^[A-Za-z]{1,4}$/.test(element) && !NON_HEAVY_ELEMENTS.has(element.toUpperCase());
}
function distanceText(distance) {
  return `${distance.toFixed(2)} \xC5`;
}
function readAtom(value) {
  if (!value || !Number.isSafeInteger(value.index) || value.index < 0 || typeof value.name !== "string" || !/^[!-~]{1,24}$/.test(value.name) || !isHeavyElement(value.element) || typeof value.altLocation !== "string" || !/^[!-~]{0,4}$/.test(value.altLocation)) {
    throw new Error("Invalid heavy atom in the measurement.");
  }
  return { index: value.index, name: value.name, element: value.element, altLocation: value.altLocation };
}
function normalizeMeasurement(value) {
  if (value === null) return null;
  if (!value || !Array.isArray(value.endpoints) || value.endpoints.length !== 2 || !Number.isFinite(value.distanceAngstrom) || value.distanceAngstrom < 0) {
    throw new Error("Invalid residue distance measurement.");
  }
  const endpoints = value.endpoints.map((endpoint) => {
    const residue = normalizePickedResidue(endpoint?.residue);
    if (!residue) throw new Error("A residue is required for each measurement endpoint.");
    return { residue, atom: readAtom(endpoint?.atom) };
  });
  const [first, second] = endpoints;
  if (residueKey(first.residue) === residueKey(second.residue) || first.residue.modelNumber !== second.residue.modelNumber || first.atom.index === second.atom.index) {
    throw new Error("A distance measurement needs two distinct residues in the same model.");
  }
  return { endpoints, distanceAngstrom: value.distanceAngstrom };
}
function lastMeasurementText(measurement) {
  const endpoints = measurement.endpoints.map(({ residue, atom }) => {
    const alt = atom.altLocation ? `, alternate location ${JSON.stringify(atom.altLocation)}` : "";
    return `[${residueIdentityText(residue)}, heavy atom ${JSON.stringify(atom.name)} (${atom.element})${alt}]`;
  });
  return `User's last measurement (closest heavy-atom pair): ${endpoints.join(" to ")}, ${distanceText(measurement.distanceAngstrom)}.`;
}

// src/workbench.js
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

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
    return new Promise((resolve3, reject) => {
      const id = ++nextId;
      function settle(error, result) {
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve3(result);
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
      tools: new Map(tools.map((tool3) => [tool3.name, tool3])),
      call: (name, args, signal) => request2("tools/call", { name, arguments: args }, signal),
      close: () => server.close()
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

// src/workbench-contract.js
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
function visibleTo(tool3, audience) {
  return tool3?._meta?.ui?.visibility?.includes(audience);
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
    "Open once and reuse the returned viewerId for comparison, scientific analysis and rendering.",
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
      plugin: "dsh-molecular-viewer",
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
    if (Boolean(input.source) === Boolean(input.exampleId)) {
      throw new Error("Supply one workspace source file or exampleId.");
    }
    const path = input.source && await sourcePath(root, input.source);
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
  async function openForAgent(agent, root, args, signal) {
    const imported = typeof args.source === "string" ? importSource(args.source.trim()) : void 0;
    if (!imported || args.exampleId) return openWorkbench(agent.id, root, args, signal);
    if (!imported.text && !isAbsolute(args.source) && await stat(resolve(root, args.source)).then((info) => info.isFile(), () => false)) {
      return openWorkbench(agent.id, root, args, signal);
    }
    requireWorkspaceWrite(agent);
    const { file, directory } = await importStructure(root, imported, signal);
    try {
      return await openWorkbench(agent.id, root, { ...args, source: file }, signal);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
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
    const root = await resolveRoot(agent, exec.signal);
    if (args.action === "operations" || args.action === "help") return operationHelp(args, root);
    if (args.action === "open") {
      const record = await openForAgent(agent, root, args, exec.signal);
      return {
        ok: true,
        action: args.action,
        summary: `Opened ${record.title} in the Molecular Structure Workbench.`,
        data: { viewerId: record.id, title: record.title, placement: record.placement },
        scene: scene(record, turns.get(agent.session))
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
        const record = previous?.record ?? await openWorkbench(agent.id, root, { source: path, placement: "sidebar" }, void 0, previewAddress);
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
var TOOL_NAME = "molecular_viewer";
var ROUTE_ROOT = "/dsh-molecular-viewer";
var STRUCTURE_PREFIX = `${ROUTE_ROOT}/structures`;
var STATE_PATH = `${ROUTE_ROOT}/api/state`;
var STYLES = ["cartoon", "cartoon-sticks", "sticks", "spheres", "line"];
var COLORS = ["chain", "secondary", "element", "residue", "bfactor", "uniform"];
var ACTIONS = ["open", "style", "color", "highlight", "focus", "label", "spin", "reset", "status", "close"];
var DEFAULT_ACCENT = "#f59e0b";
var DEFAULT_UNIFORM = "#5b8def";
var WATER = /* @__PURE__ */ new Set(["HOH", "WAT", "DOD", "H2O", "TIP", "TIP3", "SOL"]);
var IONS = /* @__PURE__ */ new Set([
  "NA",
  "K",
  "CL",
  "MG",
  "CA",
  "ZN",
  "FE",
  "MN",
  "CU",
  "CO",
  "NI",
  "CD",
  "HG",
  "SO4",
  "PO4",
  "NO3",
  "NH4",
  "IOD",
  "BR"
]);
var NUCLEIC = /* @__PURE__ */ new Set([
  "A",
  "C",
  "G",
  "U",
  "I",
  "DA",
  "DC",
  "DG",
  "DT",
  "DU",
  "DI",
  "ADE",
  "CYT",
  "GUA",
  "THY",
  "URA"
]);
var POLYMER_HET = /* @__PURE__ */ new Set(["MSE", "SEC", "PYL", "CSO", "CME", "MLY", "SEP", "TPO", "PTR"]);
var scenes = /* @__PURE__ */ new Map();
var pendingOpens = /* @__PURE__ */ new Map();
var hostInstance = randomUUID2();
function getScene(sessionId) {
  return scenes.get(sessionId);
}
function requireScene(sessionId) {
  const scene2 = getScene(sessionId);
  if (!scene2) throw new Error('No active structure. Call action "open" first.');
  return scene2;
}
function touch(scene2, action) {
  scene2.revision += 1;
  scene2.updatedAt = Date.now();
  scene2.action = action;
  return scene2;
}
function cacheDirectory() {
  const home = process.env.DSH_HOME || join2(homedir2(), ".dsh");
  return join2(home, "cache", "dsh-molecular-viewer");
}
function structurePath(fileName) {
  if (!/^[A-Za-z0-9_-]+\.(pdb|cif)$/.test(fileName)) throw new Error("Invalid structure file name.");
  return join2(cacheDirectory(), fileName);
}
function structureUrl(fileName) {
  return `${STRUCTURE_PREFIX}/${fileName}`;
}
function isWater(resn) {
  return WATER.has(resn);
}
function isPolymerResidue(record, resn) {
  return record === "ATOM" || POLYMER_HET.has(resn);
}
function formatCount(value) {
  return new Intl.NumberFormat("en-US").format(value);
}
function cleanTitle(value) {
  return String(value ?? "").replace(/\s+/g, " ").replace(/[;\s]+$/, "").trim();
}
function normalizeHex(value, fallback) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}
function selectionOf(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const output = {};
  if (typeof input.chain === "string" && input.chain.trim() !== "") output.chain = input.chain.trim();
  if (typeof input.resn === "string" && input.resn.trim() !== "") {
    const names = input.resn.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    if (names.length === 0) return null;
    output.resn = names.length === 1 ? names[0] : names;
  }
  if (typeof input.resi === "string" && input.resi.trim() !== "") output.resi = input.resi.trim();
  else if (typeof input.resi === "number" && Number.isFinite(input.resi)) output.resi = String(input.resi);
  return Object.keys(output).length === 0 ? null : output;
}
function selectionText(selection) {
  const parts = [];
  if (selection.chain !== void 0) parts.push(`chain ${selection.chain || "\u2014"}`);
  if (selection.resn !== void 0) parts.push(Array.isArray(selection.resn) ? selection.resn.join(", ") : selection.resn);
  if (selection.resi !== void 0) parts.push(`resi ${selection.resi}`);
  return parts.join(" ");
}
function selectionKey(selection) {
  return JSON.stringify(selection, Object.keys(selection).sort());
}
function sceneStyleLabel(style) {
  return { cartoon: "cartoon", "cartoon-sticks": "cartoon + sticks", sticks: "sticks", spheres: "spheres", line: "lines" }[style] ?? style;
}
function sceneColorLabel(color) {
  return { chain: "chain", secondary: "secondary structure", element: "element", residue: "residue", bfactor: "B-factor", uniform: "single color" }[color] ?? color;
}
function defaultDisplay(stats) {
  if (stats.polymer === false) return { style: "sticks", color: "element" };
  return {
    style: "cartoon",
    color: stats.chains?.length === 1 ? "secondary" : "chain"
  };
}
function parsePdb(text, fallback = {}) {
  const chains = /* @__PURE__ */ new Map();
  const ligands = /* @__PURE__ */ new Map();
  let atoms = 0;
  let waters = 0;
  let sourceId = "";
  let classification = "";
  let title = "";
  let resolution = "";
  let modelCount = 0;
  let proteinResidues = 0;
  let nucleicResidues = 0;
  const seenResidues = /* @__PURE__ */ new Set();
  const addChain = (id) => {
    let chain = chains.get(id);
    if (!chain) {
      chain = { id, atoms: 0, residues: /* @__PURE__ */ new Set(), polymerResidues: /* @__PURE__ */ new Set() };
      chains.set(id, chain);
    }
    return chain;
  };
  for (const line of text.split(/\r?\n/)) {
    const record = line.slice(0, 6).trim();
    if (record === "HEADER") {
      classification = cleanTitle(line.slice(10, 50));
      sourceId = cleanTitle(line.slice(62, 66));
      continue;
    }
    if (record === "TITLE") {
      title += ` ${line.slice(10).trim()}`;
      continue;
    }
    if (record === "REMARK" && line.slice(7, 10) === "  2" && /RESOLUTION\.\s+([\d.]+)\s+ANGSTROM/i.test(line)) {
      resolution = line.match(/RESOLUTION\.\s+([\d.]+)\s+ANGSTROM/i)[1];
      continue;
    }
    if (record === "MODEL") {
      modelCount += 1;
      if (modelCount > 1) break;
      continue;
    }
    if (record === "ENDMDL") {
      if (modelCount >= 1) break;
      continue;
    }
    if (record !== "ATOM" && record !== "HETATM") continue;
    const altLoc = line[16] ?? " ";
    if (altLoc !== " " && altLoc !== "A") continue;
    const resn = line.slice(17, 20).trim();
    const chainId = line.slice(21, 22);
    const resi = line.slice(22, 26).trim();
    const icode = line[26] ?? " ";
    if (!resn || !resi || ![line.slice(30, 38), line.slice(38, 46), line.slice(46, 54)].every((value) => value.trim() && Number.isFinite(Number(value)))) continue;
    atoms += 1;
    const chain = addChain(chainId);
    chain.atoms += 1;
    const key = `${chainId}|${resn}|${resi}|${icode}`;
    if (record === "HETATM" && !isWater(resn) && !isPolymerResidue(record, resn)) {
      let ligand = ligands.get(key);
      if (!ligand) {
        ligand = { resn, chain: chainId.trim(), resi, icode: icode.trim(), atoms: 0, ion: IONS.has(resn) };
        ligands.set(key, ligand);
      }
      ligand.atoms += 1;
    }
    if (seenResidues.has(key)) continue;
    seenResidues.add(key);
    if (isWater(resn)) {
      waters += 1;
      continue;
    }
    chain.residues.add(key);
    if (isPolymerResidue(record, resn)) chain.polymerResidues.add(key);
    if (NUCLEIC.has(resn)) nucleicResidues += 1;
    else if (record === "ATOM" || POLYMER_HET.has(resn)) proteinResidues += 1;
  }
  if (!atoms) throw new Error("The PDB contains no usable atom coordinates in its first model.");
  const chainList = [...chains.values()].map((chain) => ({
    id: chain.id,
    atoms: chain.atoms,
    residues: chain.residues.size,
    polymerResidues: chain.polymerResidues.size
  })).filter((chain) => chain.atoms > 0).sort((a, b) => a.id.localeCompare(b.id));
  const residueCount = chainList.reduce((sum, chain) => sum + chain.residues, 0);
  const polymerCount = chainList.reduce((sum, chain) => sum + chain.polymerResidues, 0);
  const ligandList = [...ligands.values()].filter((ligand) => !ligand.ion).sort((a, b) => b.atoms - a.atoms || a.resn.localeCompare(b.resn));
  const nucleic = nucleicResidues >= 3;
  const protein = proteinResidues >= 5;
  const kind = protein && nucleic ? "Protein\u2013nucleic acid complex" : protein ? "Protein" : nucleic ? "Nucleic acid" : polymerCount > 0 ? "Polymer" : "Small molecule";
  const summaryParts = [
    `${kind} \xB7 ${formatCount(atoms)} atoms \xB7 ${formatCount(residueCount)} residues \xB7 ${chainList.length || 1} chain${(chainList.length || 1) === 1 ? "" : "s"}`
  ];
  const namedLigands = ligandList.slice(0, 4);
  if (namedLigands.length > 0) {
    summaryParts.push(`ligands ${namedLigands.map((ligand) => `${ligand.resn}${ligand.chain ? `:${ligand.chain}` : ""}`).join(", ")}`);
  }
  if (waters > 0) summaryParts.push(`${formatCount(waters)} waters hidden`);
  return {
    title: cleanTitle(title) || fallback.title || "",
    pdbId: sourceId || fallback.pdbId || "",
    classification,
    resolution,
    atoms,
    residues: residueCount,
    chains: chainList,
    ligands: ligandList,
    waters,
    polymer: polymerCount > 0,
    protein,
    nucleic,
    kind,
    summary: summaryParts.join(" \xB7 ")
  };
}
function parseCif(text, fallback = {}) {
  const titleMatch = text.match(/^_struct\.title[ \t]*(?:\r?\n;([\s\S]*?)\r?\n;|\s+('[^']*'|"[^"]*"|[^\s;]+))/m);
  const title = cleanTitle(titleMatch?.[1] ?? titleMatch?.[2]?.replace(/^['"]|['"]$/g, "")) || fallback.title || "";
  const idMatch = text.match(/_entry\.id\s+(\S+)/);
  return {
    title,
    pdbId: cleanTitle(idMatch?.[1] ?? fallback.pdbId ?? ""),
    classification: "",
    resolution: "",
    atoms: null,
    residues: null,
    chains: null,
    ligands: null,
    waters: null,
    polymer: null,
    protein: null,
    nucleic: null,
    kind: "Structure",
    summary: "mmCIF structure \xB7 atom-level statistics unavailable in this version"
  };
}
function sniffFormat(text, fileName = "") {
  if (/^[ \t]*data_\S+/mi.test(text)) return "cif";
  if (/^(?:ATOM  |HETATM)/m.test(text)) return "pdb";
  const extension = extname(fileName).toLowerCase();
  if (extension === ".cif" || extension === ".mmcif") return "cif";
  return "pdb";
}
function parseStructure(text, format, fallback) {
  if (format === "pdb") return parsePdb(text, fallback);
  const hasDataBlock = /^[ \t]*data_(?!global\s)\S+/mi.test(text);
  const hasCoordinates = ["cartn", "fract"].some((type) => ["x", "y", "z"].every((axis) => new RegExp(`^\\s*_atom_site[._]${type}_${axis}\\b`, "im").test(text)));
  if (!hasDataBlock || !hasCoordinates) throw new Error("The mmCIF is missing its atom coordinates or data block.");
  return parseCif(text, fallback);
}
async function readStructureFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("The structure path must be a regular file.");
    if (info.size > MAX_STRUCTURE_BYTES) throw new Error("Structure file exceeds the 40 MiB limit.");
    return await readStructureText(handle.createReadStream(), info.size);
  } finally {
    await handle.close();
  }
}
async function fetchRcsb(pdbId, exec) {
  const id = pdbId.toUpperCase();
  let lastError;
  for (const format of ["pdb", "cif"]) {
    const url = `https://files.rcsb.org/download/${id}.${format}`;
    try {
      const { text } = await downloadStructure(url, exec?.signal, `RCSB PDB ${id}`);
      const parsed = parseStructure(text, format, { pdbId: id });
      return { text, format, parsed, kind: "pdb", label: `PDB ${id}`, pdbId: id };
    } catch (error) {
      lastError = error;
      if (exec?.signal?.aborted) throw error;
    }
  }
  throw new Error(`Could not download PDB ${id} from RCSB. ${lastError?.message ?? ""}`.trim());
}
async function resolveLocalPath(source, ctx, exec) {
  let candidate = source;
  if (candidate === "~" || candidate.startsWith("~/")) candidate = join2(homedir2(), candidate.slice(1));
  if (!isAbsolute2(candidate)) {
    let cwd = process.cwd();
    try {
      if (ctx?.workingDirectory && exec?.agent) cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
    } catch {
      exec?.signal?.throwIfAborted();
      throw new Error("Could not resolve the session working directory. Supply an absolute structure path.");
    }
    candidate = resolve2(cwd, candidate);
  }
  return (await stat2(candidate).catch(() => null))?.isFile() ? candidate : null;
}
async function resolveSource(source, ctx, exec) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error('The "source" argument is required for action "open": use a 4-character RCSB PDB ID, a local .pdb/.cif path, a URL, or inline PDB text.');
  }
  const raw = source.trim();
  if (/^data_\S+/i.test(raw) || /^(?:ATOM  |HETATM|HEADER|TITLE )/m.test(raw)) {
    if (Buffer.byteLength(raw) > MAX_STRUCTURE_BYTES) throw new Error("Structure file exceeds the 40 MiB limit.");
    const format = sniffFormat(raw);
    return { text: raw, format, kind: "inline", label: format === "cif" ? "inline mmCIF" : "inline PDB", pdbId: "" };
  }
  if (/^https?:\/\//i.test(raw)) {
    const { text, url } = await downloadStructure(raw, exec?.signal, "Structure URL");
    const format = sniffFormat(text, url.pathname);
    return { text, format, kind: "url", label: `${url.host}${url.pathname}`, pdbId: "" };
  }
  if (/^(?:pdb:)?[0-9][A-Za-z0-9]{3}$/i.test(raw)) return fetchRcsb(raw.replace(/^pdb:/i, ""), exec);
  const localPath = await resolveLocalPath(raw, ctx, exec);
  if (localPath) {
    const text = await readStructureFile(localPath);
    const format = sniffFormat(text, localPath);
    return { text, format, kind: "file", label: basename2(localPath), pdbId: "" };
  }
  const bare = raw.replace(/^pdb:/i, "").replace(/\.(pdb|cif|mmcif)$/i, "");
  if (/^[0-9][A-Za-z0-9]{3}$/.test(bare)) return fetchRcsb(bare, exec);
  throw new Error("Cannot resolve the structure source. Use a 4-character RCSB PDB ID, an existing .pdb/.cif file, an HTTPS URL, or inline PDB/mmCIF text.");
}
async function storeStructure(text, format) {
  await mkdir2(cacheDirectory(), { recursive: true, mode: 448 });
  const digest = createHash2("sha1").update(text).digest("hex").slice(0, 20);
  const fileName = `${digest}.${format === "cif" ? "cif" : "pdb"}`;
  const target = structurePath(fileName);
  if (!await access(target).then(() => true, () => false)) {
    const temporary = `${target}.${randomUUID2()}.tmp`;
    try {
      await writeFile2(temporary, text, { encoding: "utf8", flag: "wx", mode: 384 });
      await rename2(temporary, target);
    } finally {
      await rm2(temporary, { force: true });
    }
  }
  return { id: digest, fileName, url: structureUrl(fileName) };
}
function makeScene(source, display, stored, overrides, revision) {
  return {
    id: stored.id,
    url: stored.url,
    format: source.format,
    title: (cleanTitle(overrides.title) || source.parsed.title || source.label).slice(0, 240),
    pdbId: source.parsed.pdbId || source.pdbId || "",
    source: { kind: source.kind, label: source.label },
    summary: source.parsed.summary,
    stats: {
      atoms: source.parsed.atoms,
      residues: source.parsed.residues,
      chains: source.parsed.chains?.length ?? null,
      ligands: source.parsed.ligands?.length ?? null,
      waters: source.parsed.waters,
      polymer: source.parsed.polymer,
      protein: source.parsed.protein,
      nucleic: source.parsed.nucleic
    },
    style: overrides.style ?? display.style,
    color: overrides.color ?? display.color,
    colorHex: normalizeHex(overrides.colorHex, DEFAULT_UNIFORM),
    spin: overrides.spin === true,
    highlights: [],
    labels: [],
    focus: null,
    selectedResidue: null,
    lastMeasurement: null,
    visible: true,
    revision,
    generation: `${hostInstance}:${revision}`,
    updatedAt: Date.now(),
    action: "open"
  };
}
function sceneSummary(scene2) {
  const parts = [
    `${scene2.title}${scene2.pdbId ? ` (PDB ${scene2.pdbId})` : ""}.`,
    scene2.summary + ".",
    `Viewer: ${sceneStyleLabel(scene2.style)}, colored by ${sceneColorLabel(scene2.color)}${scene2.spin ? ", spinning" : ""}.`
  ];
  if (scene2.focus) parts.push(`Focused on ${scene2.focus.text}.`);
  if (scene2.selectedResidue) parts.push(`User-selected residue: ${pickedResidueText(scene2.selectedResidue)}.`);
  if (scene2.lastMeasurement) parts.push(lastMeasurementText(scene2.lastMeasurement));
  if (scene2.highlights.length > 0) parts.push(`Highlights: ${scene2.highlights.map((item) => item.text).join("; ")}.`);
  if (scene2.labels.length > 0) parts.push(`Labels: ${scene2.labels.map((item) => item.text).join("; ")}.`);
  return parts.join(" ");
}
function scenePrompt(scene2) {
  const parts = [
    scene2.visible ? "There is an active molecular structure viewer in this conversation." : "The molecular structure viewer in this conversation is currently hidden.",
    `Scene settings: ${sceneStyleLabel(scene2.style)}, colored by ${sceneColorLabel(scene2.color)}${scene2.spin ? ", spinning" : ""}.`
  ];
  if (scene2.selectedResidue) parts.push(`User-selected residue: ${pickedResidueText(scene2.selectedResidue)}.`);
  if (scene2.lastMeasurement) parts.push(lastMeasurementText(scene2.lastMeasurement));
  parts.push('Call molecular_viewer with action "status" for structure metadata, the current selection, and the last completed distance measurement.');
  return parts.join(" ");
}
function applyViewPatch(sessionId, patch) {
  const scene2 = getScene(sessionId);
  if (!scene2) return null;
  const picked = Object.hasOwn(patch, "selectedResidue") ? normalizePickedResidue(patch.selectedResidue) : void 0;
  const measurement = Object.hasOwn(patch, "lastMeasurement") ? normalizeMeasurement(patch.lastMeasurement) : void 0;
  let changed = false;
  if (STYLES.includes(patch.style) && patch.style !== scene2.style) {
    checkStyle(patch.style, scene2.stats);
    scene2.style = patch.style;
    changed = true;
  }
  if (COLORS.includes(patch.color) && patch.color !== scene2.color) {
    scene2.color = patch.color;
    changed = true;
  }
  const colorHex = normalizeHex(patch.colorHex, scene2.colorHex);
  if (colorHex !== scene2.colorHex) {
    scene2.colorHex = colorHex;
    changed = true;
  }
  if (typeof patch.spin === "boolean" && patch.spin !== scene2.spin) {
    scene2.spin = patch.spin;
    changed = true;
  }
  if (typeof patch.visible === "boolean" && patch.visible !== scene2.visible) {
    scene2.visible = patch.visible;
    changed = true;
  }
  if (picked !== void 0 && JSON.stringify(picked) !== JSON.stringify(scene2.selectedResidue)) {
    scene2.selectedResidue = picked;
    changed = true;
  }
  if (measurement !== void 0 && JSON.stringify(measurement) !== JSON.stringify(scene2.lastMeasurement)) {
    scene2.lastMeasurement = measurement;
    changed = true;
  }
  if (!changed) return scene2;
  return touch(scene2, "view");
}
function openScene(sessionId, source, overrides) {
  const display = defaultDisplay(source.parsed);
  const scene2 = makeScene(source, display, source.stored, overrides, (getScene(sessionId)?.revision ?? 0) + 1);
  scenes.set(sessionId, scene2);
  return scene2;
}
function checkStyle(style, stats) {
  if (!STYLES.includes(style)) throw new Error(`Style must be one of: ${STYLES.join(", ")}.`);
  if (stats.polymer === false && style.startsWith("cartoon")) {
    throw new Error('Cartoon representation needs a polymer. Use "sticks", "spheres", or "line" for a small molecule.');
  }
}
function checkLabelLimit(scene2, label) {
  if (label && scene2.labels.length >= 16) throw new Error("At most 16 labels can be shown at once. Reset or open the structure again.");
}
function actionError(action, message) {
  return { ok: false, action, summary: `Molecular viewer error: ${message}`, error: message };
}
async function runAction(args, exec, pluginCtx) {
  const sessionId = exec?.agent?.id;
  if (!sessionId) throw new Error("The molecular viewer needs an active DSH session.");
  const action = args.action;
  if (action === "open") {
    if (args.color !== void 0 && !COLORS.includes(args.color)) throw new Error(`Color must be one of: ${COLORS.join(", ")}.`);
    const token2 = /* @__PURE__ */ Symbol();
    pendingOpens.set(sessionId, token2);
    try {
      const source = await resolveSource(args.source, pluginCtx, exec);
      const parsed = source.parsed ?? parseStructure(source.text, source.format, { pdbId: source.pdbId });
      if (args.style !== void 0) checkStyle(args.style, parsed);
      exec.signal?.throwIfAborted();
      const stored = await storeStructure(source.text, source.format);
      exec.signal?.throwIfAborted();
      if (pendingOpens.get(sessionId) !== token2) throw new Error("A newer open request superseded this one.");
      const scene3 = openScene(sessionId, { ...source, parsed, stored }, args);
      return { ok: true, action, summary: `Prepared ${sceneSummary(scene3)}`, scene: scene3 };
    } finally {
      if (pendingOpens.get(sessionId) === token2) pendingOpens.delete(sessionId);
    }
  }
  if (action === "status") {
    const scene3 = getScene(sessionId);
    if (!scene3) return actionError(action, 'No active structure. Call action "open" first.');
    const summary = scene3.visible ? sceneSummary(scene3) : `The molecular viewer is hidden. ${sceneSummary(scene3)}`;
    return { ok: true, action, summary, scene: scene3 };
  }
  const scene2 = requireScene(sessionId);
  if (action === "close") {
    scene2.visible = false;
    touch(scene2, action);
    return { ok: true, action, summary: `Hid the molecular viewer for ${scene2.title}. The structure remains loaded.`, scene: scene2 };
  }
  if (action === "style") {
    checkStyle(args.style, scene2.stats);
    scene2.style = args.style;
    touch(scene2, action);
    return { ok: true, action, summary: `Changed representation to ${sceneStyleLabel(scene2.style)}. ${sceneSummary(scene2)}`, scene: scene2 };
  }
  if (action === "color") {
    if (!COLORS.includes(args.color)) throw new Error(`Color must be one of: ${COLORS.join(", ")}.`);
    scene2.color = args.color;
    if (args.color === "uniform") scene2.colorHex = normalizeHex(args.colorHex, scene2.colorHex || DEFAULT_UNIFORM);
    touch(scene2, action);
    return { ok: true, action, summary: `Colored by ${sceneColorLabel(scene2.color)}. ${sceneSummary(scene2)}`, scene: scene2 };
  }
  if (action === "highlight") {
    const selection = selectionOf(args.selection);
    if (!selection) throw new Error('Highlight needs a selection with chain, resn, and/or resi (for example {"chain":"A","resi":"45-60"}).');
    const key = selectionKey(selection);
    if (scene2.highlights.some((item) => item.key === key)) throw new Error(`That selection is already highlighted: ${selectionText(selection)}.`);
    if (scene2.highlights.length >= 12) throw new Error("At most 12 highlights can be shown at once. Reset or open the structure again.");
    const label = typeof args.label === "string" ? cleanTitle(args.label).slice(0, 120) : "";
    checkLabelLimit(scene2, label);
    const text = `${selectionText(selection)}${label ? ` \u2014 ${label}` : ""}`;
    scene2.highlights.push({
      key,
      selection,
      colorHex: normalizeHex(args.colorHex, DEFAULT_ACCENT),
      text,
      label
    });
    if (label) scene2.labels.push({ selection, text: label, selectionText: selectionText(selection) });
    touch(scene2, action);
    return { ok: true, action, summary: `Highlighted ${text}. ${sceneSummary(scene2)}`, scene: scene2 };
  }
  if (action === "focus") {
    const selection = selectionOf(args.selection);
    if (!selection) throw new Error('Focus needs a selection with chain, resn, and/or resi (for example {"chain":"A","resi":"45-60"}).');
    const label = typeof args.label === "string" ? cleanTitle(args.label).slice(0, 120) : "";
    checkLabelLimit(scene2, label);
    scene2.focus = { selection, revision: scene2.revision + 1, text: `${selectionText(selection)}${label ? ` \u2014 ${label}` : ""}` };
    if (label) scene2.labels.push({ selection, text: label, selectionText: selectionText(selection) });
    touch(scene2, action);
    return { ok: true, action, summary: `Focused the camera on ${scene2.focus.text}. ${sceneSummary(scene2)}`, scene: scene2 };
  }
  if (action === "label") {
    const selection = selectionOf(args.selection);
    if (!selection) throw new Error("Label needs a selection with chain, resn, and/or resi.");
    const text = cleanTitle(args.label).slice(0, 120);
    if (!text) throw new Error('Label needs non-empty "label" text.');
    checkLabelLimit(scene2, text);
    scene2.labels.push({ selection, text, selectionText: selectionText(selection) });
    touch(scene2, action);
    return { ok: true, action, summary: `Labeled ${selectionText(selection)} as "${text}". ${sceneSummary(scene2)}`, scene: scene2 };
  }
  if (action === "spin") {
    if (typeof args.spin !== "boolean") throw new Error('Spin needs a boolean "spin" argument.');
    scene2.spin = args.spin;
    touch(scene2, action);
    return { ok: true, action, summary: `${args.spin ? "Started" : "Stopped"} spinning the structure. ${sceneSummary(scene2)}`, scene: scene2 };
  }
  if (action === "reset") {
    scene2.highlights = [];
    scene2.labels = [];
    scene2.focus = null;
    scene2.selectedResidue = null;
    scene2.lastMeasurement = null;
    scene2.spin = false;
    touch(scene2, action);
    return { ok: true, action, summary: `Reset highlights, labels, focus, residue selection, measurement, and spinning. ${sceneSummary(scene2)}`, scene: scene2 };
  }
  throw new Error(`Unknown action "${action}".`);
}
var tool2 = {
  name: TOOL_NAME,
  description: [
    "Control an existing lightweight viewer created with molecular_viewer. Prefer molecular_workbench for new visualizations and advanced structural analysis. Open and control a live 3D molecular structure viewer in the conversation. The user sees the same viewer, so this is for showing and annotating a structure rather than returning coordinates.",
    'Open with a 4-character RCSB PDB ID (for example "1CRN" or "5LF3"), a local .pdb/.cif path, a public HTTPS URL, or inline PDB/mmCIF text. Then use actions to style, color, highlight, focus, label, spin, reset, hide, or inspect the active scene.',
    'Use chain/resn/resi selections for binding sites and subunits; never invent residue numbers. Call action "status" for the current selection, focus, or last completed distance measurement. Structural facts not present in the returned summary should be read from the structure file or another scientific tool.'
  ].join(" "),
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        required: true,
        enum: ACTIONS,
        description: "open a structure, then style/color/highlight/focus/label/spin/reset it, read status, or close the viewer."
      },
      source: {
        type: "string",
        description: 'For action "open": RCSB PDB ID (4 characters), local .pdb/.cif path, public HTTPS URL, or inline PDB/mmCIF text.'
      },
      title: {
        type: "string",
        description: "Optional title override for the opened scene."
      },
      style: {
        type: "string",
        enum: STYLES,
        description: 'Representation. Cartoon includes ligand sticks; "cartoon-sticks" adds protein sticks.'
      },
      color: {
        type: "string",
        enum: COLORS,
        description: 'Color scheme. "secondary" uses secondary structure, "chain" colors subunits.'
      },
      colorHex: {
        type: "string",
        description: 'Hex color for uniform coloring or highlights, for example "#f59e0b".'
      },
      selection: {
        type: "object",
        additionalProperties: false,
        description: 'Selection for highlight/focus/label: chain, resn, and/or resi. resi may be a range like "45-60".',
        properties: {
          chain: { type: "string", description: 'Chain identifier, for example "A".' },
          resn: { type: "string", description: 'Residue name, for example "BTZ" or "GLU"; comma-separate multiple names.' },
          resi: { type: "string", description: 'Residue number or range, for example "45" or "45-60".' }
        }
      },
      label: {
        type: "string",
        description: 'Short annotation text for highlight/focus/label, for example "\u03B25 catalytic site".'
      },
      spin: {
        type: "boolean",
        description: 'For action "spin": true starts slow rotation, false stops it.'
      }
    }
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "action", "summary"],
      properties: {
        ok: { type: "boolean" },
        action: { type: "string" },
        summary: { type: "string" },
        error: { type: "string" },
        scene: {
          type: "object",
          additionalProperties: true,
          required: ["id", "url", "title", "style", "color", "visible", "revision"],
          properties: {
            id: { type: "string" },
            url: { type: "string" },
            format: { type: "string" },
            title: { type: "string" },
            pdbId: { type: "string" },
            summary: { type: "string" },
            style: { type: "string" },
            color: { type: "string" },
            colorHex: { type: "string" },
            spin: { type: "boolean" },
            visible: { type: "boolean" },
            lastMeasurement: {
              oneOf: [
                { type: "null" },
                {
                  type: "object",
                  required: ["endpoints", "distanceAngstrom"],
                  properties: { endpoints: { type: "array" }, distanceAngstrom: { type: "number" } }
                }
              ]
            },
            revision: { type: "number" },
            highlights: { type: "array" },
            labels: { type: "array" },
            stats: { type: "object" }
          }
        }
      }
    },
    render: (_args, value) => [{
      type: "text",
      text: value.summary
    }],
    presentationMeta: (_args, value) => ({
      plugin: "dsh-molecular-viewer",
      ok: value.ok,
      action: value.action,
      summary: value.summary,
      error: value.error ?? null,
      scene: value.scene ?? null
    })
  }
};
function sendJson(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}
function readJsonBody(request2, limit = 64 * 1024) {
  return new Promise((resolve3, reject) => {
    const length = Number(request2.headers["content-length"] ?? "0");
    if (length > limit) {
      reject(new Error("Request body is too large."));
      request2.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    request2.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body is too large."));
        request2.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request2.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve3({});
      try {
        resolve3(JSON.parse(text));
      } catch {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    request2.on("error", reject);
  });
}
function registerRoutes(ctx) {
  ctx.effect(() => {
    const disposeStructures = ctx.webServer.register({
      kind: "prefix",
      path: STRUCTURE_PREFIX,
      resource: async (request2, peer) => {
        try {
          const rejection = peer ? void 0 : ctx.connection.requestRejection(request2);
          if (rejection !== void 0) return new Response(null, { status: rejection });
          const pathname = new URL(request2.url).pathname;
          const fileName = decodeURIComponent(pathname.slice(STRUCTURE_PREFIX.length + 1));
          const path = structurePath(fileName);
          if (!(await stat2(path)).isFile()) return new Response(null, { status: 404 });
          return new Response(request2.method === "HEAD" ? null : Readable.toWeb(createReadStream(path)), {
            headers: {
              "content-type": fileName.endsWith(".cif") ? "chemical/x-cif; charset=utf-8" : "chemical/x-pdb; charset=utf-8",
              "cache-control": "private, max-age=31536000, immutable",
              "x-content-type-options": "nosniff",
              "cross-origin-resource-policy": "same-origin"
            }
          });
        } catch {
          return new Response("Structure not found", { status: 404 });
        }
      }
    });
    const disposeState = ctx.webServer.register({
      kind: "exact",
      path: STATE_PATH,
      handler: (request2, response) => {
        void (async () => {
          try {
            const rejection = ctx.connection.requestRejection(request2);
            if (rejection !== void 0) return sendJson(response, { ok: false, error: "Open the viewer from an authenticated DSH session." }, rejection);
            if (request2.method === "GET") {
              const sessionId = new URL(request2.url, "http://localhost").searchParams.get("sessionId");
              if (!sessionId) return sendJson(response, { ok: false, error: "sessionId is required." }, 400);
              return sendJson(response, { ok: true, scene: getScene(sessionId) ?? null });
            }
            if (request2.method !== "POST") return sendJson(response, { ok: false, error: "Use GET or POST." }, 405);
            if (request2.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
              return sendJson(response, { ok: false, error: "Use application/json." }, 415);
            }
            const body = await readJsonBody(request2);
            if (typeof body?.sessionId !== "string" || !body.sessionId) return sendJson(response, { ok: false, error: "sessionId is required." }, 400);
            const current = getScene(body.sessionId);
            if (current && (body.generation !== void 0 || Object.hasOwn(body, "selectedResidue") || Object.hasOwn(body, "lastMeasurement")) && body.generation !== current.generation) {
              return sendJson(response, { ok: false, error: "The active structure changed." }, 409);
            }
            const scene2 = applyViewPatch(body.sessionId, body);
            if (!scene2) return sendJson(response, { ok: false, error: "No active structure for this session." }, 404);
            return sendJson(response, { ok: true, scene: scene2 });
          } catch (error) {
            if (!response.headersSent) sendJson(response, { ok: false, error: error instanceof Error ? error.message : String(error) }, 400);
            else response.end();
          }
        })();
      }
    });
    return () => {
      disposeState();
      disposeStructures();
    };
  });
}
var inject = ["tools", "webServer", "connection", "systemPrompt", "workingDirectory", "agents", "workspaceFiles", "sandboxPolicy"];
function apply(ctx) {
  const turns = /* @__PURE__ */ new WeakMap();
  ctx.on("session/event", (session, event) => {
    if (event.type === "turn/start") turns.set(session, event.data.turn);
    if (event.type === "turn/end") turns.delete(session);
  }, { global: true });
  ctx.tools.register({
    ...tool2,
    execute: async (args, exec) => {
      try {
        const turn = turns.get(exec.agent?.session);
        const result = structuredClone(await runAction(args, exec, ctx));
        if (result.ok && result.action === "open" && turn !== void 0) result.scene.turn = turn;
        return result;
      } catch (error) {
        return actionError(args.action, error instanceof Error ? error.message : String(error));
      }
    }
  });
  ctx.effect(() => ctx.systemPrompt.section({
    name: "molecular-viewer:active-scene",
    order: 8500,
    text: (context) => {
      const agent = context.agent;
      if (!agent) return "";
      const scene2 = getScene(agent.id);
      return scene2?.visible || scene2?.lastMeasurement ? scenePrompt(scene2) : "";
    }
  }));
  registerRoutes(ctx);
  registerWorkbench(ctx, turns);
}
export {
  apply,
  inject
};
