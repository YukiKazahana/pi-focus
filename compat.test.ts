import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Component } from "@earendil-works/pi-tui";
import focus from "./index.ts";

assert.ok(process.argv[2], "Pass the path to pi-compact-coordinator/index.ts");
const { default: coordinator } = await import(pathToFileURL(resolve(process.argv[2])).href);
const cwd = await mkdtemp(join(tmpdir(), "pi-focus-compat-"));
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

try {
  for (const factories of [[focus, coordinator], [coordinator, focus]]) {
    for (const scenario of ["success", "failure", "cancel", "new-input"]) {
      const handlers = new Map<string, Function[]>();
      const branch: any[] = [];
      const messages: any[] = [];
      let widget: Component | undefined;
      let expanded = false;
      let idle = false;
      let aborts = 0;
      let compaction: any;
      const theme = { fg: (_color: string, text: string) => text };
      const ctx: any = {
        cwd, mode: "tui", hasUI: true, isProjectTrusted: () => false,
        isIdle: () => idle, hasPendingMessages: () => false,
        getContextUsage: () => ({ tokens: 100_000, contextWindow: 100_000 }),
        sessionManager: { getSessionId: () => "compat", getBranch: () => branch },
        abort: () => { aborts++; },
        compact: (options: any) => { compaction = options; },
        ui: {
          setStatus() {}, notify() {},
          getToolsExpanded: () => expanded,
          setToolsExpanded: (value: boolean) => { expanded = value; },
          setWidget: (_key: string, factory: any) => { widget = factory?.({}, theme); },
        },
      };
      const pi: any = {
        events: new EventEmitter(), registerTool() {}, registerCommand() {},
        on: (name: string, handler: Function) => {
          handlers.set(name, [...handlers.get(name) ?? [], handler]);
        },
        sendMessage: (message: any) => { messages.push(message); },
      };
      const emit = async (name: string, event: any = {}) => {
        for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
      };
      const output = () => widget?.render(120).join("\n") ?? "";
      for (const factory of factories) factory(pi);
      await emit("session_start");
      await emit("agent_start");
      await emit("tool_execution_start", { toolCallId: "write", toolName: "write", args: { path: "kept.ts" } });
      await emit("tool_execution_end", { toolCallId: "write", toolName: "write", result: { content: [] }, isError: false });
      await emit("tool_execution_end", { toolCallId: "bad", toolName: "bash", result: { content: [{ type: "text", text: "kept error" }] }, isError: true });
      await emit("turn_end", { message: { role: "assistant", stopReason: "toolUse" } });
      await emit("turn_start");
      assert.equal(aborts, 1);
      await emit("agent_before_settle", { outcome: "aborted" });
      idle = true;
      await emit("agent_settled");
      assert.match(output(), /准备压缩/);
      assert.doesNotMatch(output(), /已中止/);
      await tick();
      assert.ok(compaction, "the real coordinator must request compaction");
      await emit("session_before_compact", { signal: new AbortController().signal });
      assert.match(output(), /压缩中/);

      if (scenario === "success" || scenario === "new-input") {
        branch.push({ type: "compaction", id: "compacted" });
        await emit("session_compact");
        compaction.onComplete();
      } else {
        const aborted = scenario === "cancel";
        await emit("session_compact_failed", { aborted });
        compaction.onError(new Error(aborted ? "Compaction cancelled" : "provider unavailable"));
        assert.match(output(), aborted ? /压缩已取消/ : /压缩失败/);
      }
      if (scenario === "new-input") {
        await emit("input", { source: "interactive" });
        idle = false;
        await emit("agent_start");
      }
      // Failure recovery uses two scheduled callbacks: failure handling and continuation.
      await tick();
      await tick();
      if (scenario === "success" || scenario === "failure") {
        assert.equal(messages.length, 1, "exactly one continuation");
        assert.equal(messages[0].customType, "pi-compact-coordinator");
        assert.match(output(), /恢复执行/);
        idle = false;
        await emit("agent_start");
        assert.match(output(), /已执行 2 · 失败 1/);
        assert.match(output(), /kept.ts/);
        assert.match(output(), /kept error/);
        await emit("tool_execution_end", { toolCallId: "more", toolName: "read", result: { content: [] }, isError: false });
        assert.match(output(), /已执行 3 · 失败 1/);
        await emit("agent_before_settle", { outcome: "completed" });
        idle = true;
        await emit("agent_settled");
        assert.match(output(), /本轮结束/);
      } else {
        assert.equal(messages.length, 0, "cancellation/new input suppresses continuation");
      }
      await emit("input", { source: "interactive" });
      idle = false;
      await emit("agent_start");
      assert.match(output(), /已执行 0 · 失败 0/);
      assert.doesNotMatch(output(), /kept.ts|kept error/);
      await emit("session_shutdown");
    }
  }
  console.log("PASS: both extension orders; compaction success, failure recovery, cancellation, and intervening user input");
} finally {
  await rm(cwd, { recursive: true, force: true });
}
