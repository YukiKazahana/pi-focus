import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { ExtensionRunner, initTheme, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import focus from "./index.ts";

const temp = await mkdtemp(join(tmpdir(), "pi-focus-test-"));
const handlers = new Map<string, Function>();
const tools = new Map<string, ToolDefinition<any, any, any>>();
const commands = new Map<string, any>();
const entries: any[] = [];
const historicalRows: ToolExecutionComponent[] = [];
let widget: Component | undefined;
let expanded = false;
let active = ["read", "bash", "edit", "write", "ffgrep"];
let mode = "tui";
const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const ctx: any = {
  get mode() { return mode; }, cwd: temp, isProjectTrusted: () => false,
  sessionManager: { getBranch: () => entries, getSessionId: () => "focus-test", getSessionFile: () => undefined },
  ui: {
    getToolsExpanded: () => expanded,
    setToolsExpanded: (value: boolean) => {
      if (expanded === value) return;
      expanded = value;
      for (const row of historicalRows) row.setExpanded(value);
    },
    setWidget: (_key: string, factory: any) => { widget = factory?.({}, theme); },
    notify() {},
  },
};
const api: any = {
  on: (name: string, handler: Function) => handlers.set(name, handler),
  registerCommand: (name: string, command: any) => commands.set(name, command),
  registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool),
  getAllTools: () => ["read", "bash", "edit", "write", "ffgrep"].map(name => ({
    name, sourceInfo: { source: tools.has(name) || name === "ffgrep" ? "extension" : "builtin" },
  })),
  getActiveTools: () => active,
  setActiveTools: (names: string[]) => { active = names; },
  appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data }),
};
const emit = async (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
const widgetText = () => widget?.render(100).join("\n") ?? "";
const renderContext: any = {
  args: {}, expanded: false, isPartial: false, isError: false, state: {},
  argsComplete: true, executionStarted: true, toolCallId: "test", cwd: temp,
  invalidate() {}, showImages: false,
};

try {
  focus(api as ExtensionAPI);
  assert.equal(tools.size, 4, "renderers must exist before session_start");
  mode = "rpc";
  await emit("session_start");
  assert.equal(widget, undefined, "non-TUI must not display a widget");
  mode = "tui";
  await emit("session_start");
  assert.equal(tools.size, 4);
  assert.equal(expanded, false);
  assert.deepEqual(active, ["read", "bash", "edit", "write", "ffgrep"]);
  assert.match(widgetText(), /就绪/);

  const file = join(temp, "中文.ts");
  await writeFile(file, Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"));
  const read = tools.get("read")!;
  const result = await read.execute("r", { path: file }, undefined, undefined, ctx);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /line 79/);
  const compact = read.renderResult!(result, { expanded: false, isPartial: false }, theme, renderContext);
  assert.deepEqual(compact.render(80), ["  80 行输出"]);
  for (const width of [1, 8, 20, 80]) {
    const call = read.renderCall!({ path: "中文🦄".repeat(50) }, theme, renderContext);
    assert.ok(call.render(width).every(line => visibleWidth(line) <= width));
  }
  const fail = read.renderResult!({ content: [{ type: "text", text: "first error\n" + "noise\n".repeat(100) + "last error" }], details: undefined },
    { expanded: false, isPartial: false }, theme, { ...renderContext, isError: true });
  assert.equal(fail.render(80).length, 3);
  assert.match(fail.render(80).join("\n"), /first error[\s\S]*last error/);
  assert.deepEqual(read.renderResult!(result, { expanded: false, isPartial: true }, theme, renderContext).render(80), []);

  // Exercise the real Pi tool component, including expansion and native fallback.
  initTheme("dark");
  const row = new ToolExecutionComponent("read", "r", { path: file }, { showImages: false }, read, { requestRender() {} } as any, temp);
  assert.match(row.render(80).join("\n"), /\x1b\[48;/, "pending tool background");
  row.updateResult({ ...result, isError: true });
  assert.match(row.render(80).join("\n"), /\x1b\[48;/, "failed tool background");
  row.updateResult({ ...result, isError: false });
  assert.match(row.render(80).join("\n"), /\x1b\[48;/, "successful tool background");
  assert.ok(row.render(80).length <= 5);
  row.setExpanded(true);
  assert.match(stripVTControlCharacters(row.render(100).join("\n")), /line 79/);

  await emit("agent_start");
  await emit("tool_execution_start", { toolCallId: "a", toolName: "read", args: { path: file } });
  await emit("tool_execution_start", { toolCallId: "b", toolName: "ffgrep", args: { pattern: "token" } });
  assert.match(widgetText(), /执行中 2 项/);
  await emit("tool_execution_end", { toolCallId: "b", toolName: "ffgrep", result: { content: [{ type: "text", text: "search failed" }] }, isError: true });
  await emit("tool_execution_end", { toolCallId: "a", toolName: "read", result, isError: false });
  assert.match(widgetText(), /已执行 2 · 失败 1/);
  assert.match(widgetText(), /search failed/);

  const write = tools.get("write")!;
  const outputFile = join(temp, "written.txt");
  const written = await write.execute("w", { path: outputFile, content: "before" }, undefined, undefined, ctx);
  const edit = tools.get("edit")!;
  const edited = await edit.execute("e", { path: outputFile, edits: [{ oldText: "before", newText: "after" }] }, undefined, undefined, ctx);
  assert.equal(await readFile(outputFile, "utf8"), "after");
  assert.match(edit.renderResult!(edited, { expanded: false, isPartial: false }, theme, renderContext).render(80).join("\n"), /\+1 \/ -1/);
  await emit("tool_execution_start", { toolCallId: "w", toolName: "write", args: { path: outputFile } });
  await emit("tool_execution_end", { toolCallId: "w", toolName: "write", result: written, isError: false });
  assert.match(widgetText(), /最近修改/);

  const bash = tools.get("bash")!;
  const shellResult = await bash.execute("b", { command: "printf focus-ok" }, undefined, undefined, ctx);
  assert.equal(shellResult.content[0].type === "text" && shellResult.content[0].text, "focus-ok");
  await assert.rejects(bash.execute("bad", { command: "exit 7" }, undefined, undefined, ctx), /7/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(read.execute("cancel", { path: file }, abort.signal, undefined, ctx), /abort/i);

  await emit("agent_before_settle", { outcome: "aborted" });
  await emit("agent_settled");
  assert.match(widgetText(), /已中止/);
  assert.match(widgetText(), /失败 1/);
  historicalRows.push(row);
  row.setExpanded(expanded);
  await commands.get("focus").handler("off", ctx);
  assert.equal(widget, undefined);
  assert.equal(expanded, true, "off expands historical tool output even when focus started collapsed");
  assert.match(stripVTControlCharacters(row.render(100).join("\n")), /line 79/);
  historicalRows.length = 0;
  row.setExpanded(false);
  assert.doesNotMatch(stripVTControlCharacters(row.render(100).join("\n")), /✓|80 行输出/);
  row.setExpanded(true);
  assert.match(stripVTControlCharacters(row.render(100).join("\n")), /line 79/);
  await emit("session_start");
  assert.equal(widget, undefined, "off survives session restore");
  await commands.get("focus").handler("on", ctx);
  await emit("agent_start");
  assert.match(widgetText(), /已执行 0 · 失败 0/);
  assert.doesNotMatch(widgetText(), /search failed/);
  await emit("session_shutdown");
  assert.equal(widget, undefined);
  assert.equal(expanded, true);

  // Match /reload ordering: create a new extension, restore rows, then session_start.
  for (const enabled of [true, false]) {
    entries.push({ type: "custom", customType: "pi-focus", data: { enabled } });
    tools.clear();
    focus(api as ExtensionAPI);
    const historical = new ToolExecutionComponent("read", "history", { path: file },
      { showImages: false }, tools.get("read"), { requestRender() {} } as any, temp);
    historical.updateResult({ ...result, isError: false });
    historical.setExpanded(expanded);
    historicalRows.push(historical);
    await emit("session_start", { reason: "reload" });
    const output = stripVTControlCharacters(historical.render(100).join("\n"));
    assert.equal(output.includes("80 行输出"), enabled, "restored rows must follow the saved focus mode");
    assert.equal(Boolean(widget), enabled);
    await emit("session_shutdown");
    historicalRows.length = 0;
  }

  // Pi's first registration wins: earlier third-party overrides remain intact.
  const thirdParty = { ...tools.get("read")!, execute: async () => ({ content: [], details: undefined }) };
  const runner = new ExtensionRunner([
    { tools: new Map([["read", { definition: thirdParty }]]) },
    { tools: new Map([...tools].map(([name, definition]) => [name, { definition }])) },
  ] as any, {} as any, temp, ctx.sessionManager, {} as any);
  assert.equal(runner.getAllRegisteredTools().find(tool => tool.definition.name === "read")?.definition, thirdParty);
  assert.equal(runner.getToolDefinition("read"), thirdParty);
  console.log("PASS: real tools, rendering, reload history on/off, errors, cancellation, parallel progress, settings, and extension precedence");
} finally {
  await rm(temp, { recursive: true, force: true });
}
