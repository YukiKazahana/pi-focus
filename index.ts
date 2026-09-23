import { stripVTControlCharacters } from "node:util";
import {
  createBashToolDefinition, createEditToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, SettingsManager,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

const key = "pi-focus";
const clean = (value: unknown) => stripVTControlCharacters(String(value ?? ""))
  .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
const textOf = (result: any): string => (result?.content ?? [])
  .filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
const targetOf = (args: any): string => clean(args?.path ?? args?.command ?? args?.pattern ?? args?.query ?? args?.url ?? "");

// Truncate at render time, in terminal columns (including Chinese and emoji).
function lines(getLines: () => string[]): Component {
  return { render: width => getLines().map(line => truncateToWidth(line, width)), invalidate() {} };
}

export default function focusExtension(pi: ExtensionAPI) {
  let enabled = true;
  let previousExpanded: boolean | undefined;
  let phase = "就绪";
  let completed = 0;
  let failures = 0;
  let lastFailure = "";
  let lastFile = "";
  let outcome = "本轮结束";
  const running = new Map<string, { name: string; args: any }>();

  function paint(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (!enabled) {
      ctx.ui.setWidget(key, undefined);
      return;
    }
    ctx.ui.setWidget(key, (_tui, theme) => lines(() => {
      const active = [...running.values()];
      const status = active.length
        ? `执行中 ${active.length} 项：${active.slice(0, 2).map(t => `${t.name} ${targetOf(t.args)}`).join(" · ")}`
        : phase;
      const rows = [theme.fg("muted", `专注 · ${status} · 已执行 ${completed} · 失败 ${failures}`)];
      if (lastFile) rows.push(theme.fg("muted", `最近修改：${lastFile}`));
      if (lastFailure) rows.push(theme.fg("error", `最近失败：${lastFailure}`));
      return rows;
    }));
  }

  function apply(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    if (enabled) {
      previousExpanded ??= ctx.ui.getToolsExpanded();
      ctx.ui.setToolsExpanded(false);
    } else {
      // Also invalidates existing tool rows so their native renderers return.
      ctx.ui.setToolsExpanded(previousExpanded ?? ctx.ui.getToolsExpanded());
      previousExpanded = undefined;
    }
    paint(ctx);
  }

  function compact(original: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> {
    return {
      ...original,
      renderShell: "default",
      renderCall(args, theme, context) {
        if (!enabled || context.expanded) {
          return original.renderCall?.(args, theme, context) ?? new Text(original.name, 0, 0);
        }
        const icon = context.isPartial ? "…" : context.isError ? "✗" : "✓";
        return lines(() => [theme.fg(context.isError ? "error" : "toolTitle",
          `${icon} ${original.name} ${targetOf(args)}`)]);
      },
      renderResult(result, options, theme, context) {
        if (!enabled || options.expanded) {
          return original.renderResult?.(result, options, theme, context) ?? new Text(textOf(result), 0, 0);
        }
        if (options.isPartial) return lines(() => []);
        const output = textOf(result);
        if (context.isError) {
          const nonempty = output.split("\n").map(clean).filter(Boolean);
          const excerpt = nonempty.length > 2 ? [nonempty[0], "…", nonempty.at(-1)!] : nonempty;
          return lines(() => (excerpt.length ? excerpt : ["执行失败（展开查看详情）"])
            .map(line => theme.fg("error", `  ${line}`)));
        }
        let summary = "完成";
        if (original.name === "read") {
          summary = result.content.some((part: any) => part.type === "image")
            ? "图片已读取" : `${output ? output.trimEnd().split("\n").length : 0} 行输出`;
        } else if (original.name === "edit" && result.details?.diff) {
          const diff: string[] = result.details.diff.split("\n");
          summary = `+${diff.filter(line => line.startsWith("+")).length} / -${diff.filter(line => line.startsWith("-")).length}`;
        } else if (original.name === "write") {
          const content = (context.args as { content?: string } | undefined)?.content ?? "";
          summary = `已写入 ${content ? content.split("\n").length : 0} 行`;
        } else if (original.name === "bash") {
          summary = `完成 · ${output ? output.trimEnd().split("\n").length : 0} 行输出`;
        }
        if (result.details?.truncation?.truncated) summary += " · 输出已截断";
        if (result.details?.fullOutputPath) summary += ` · 完整日志：${clean(result.details.fullOutputPath)}`;
        return lines(() => [theme.fg("muted", `  ${summary}`)]);
      },
    };
  }

  // Register renderers before Pi reconstructs historical tool rows on reload.
  // Execution uses trusted session settings once session_start supplies a context.
  let originals: ToolDefinition<any, any, any>[] = [
    createReadToolDefinition(process.cwd()), createBashToolDefinition(process.cwd()),
    createEditToolDefinition(process.cwd()), createWriteToolDefinition(process.cwd()),
  ];
  for (const original of originals) {
    pi.registerTool({
      ...compact(original),
      execute: (...args) => originals.find(tool => tool.name === original.name)!.execute(...args),
    });
  }

  pi.on("session_start", (_event, ctx) => {
    const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
    originals = [
      createReadToolDefinition(ctx.cwd, { autoResizeImages: settings.getImageAutoResize() }),
      createBashToolDefinition(ctx.cwd, { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() }),
      createEditToolDefinition(ctx.cwd), createWriteToolDefinition(ctx.cwd),
    ];
    if (ctx.mode !== "tui") return;
    enabled = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === key) {
        const data = entry.data as { enabled?: unknown } | undefined;
        if (typeof data?.enabled === "boolean") enabled = data.enabled;
      }
    }
    running.clear();
    completed = failures = 0;
    lastFailure = lastFile = "";
    phase = "就绪";
    apply(ctx);
  });

  pi.registerCommand("focus", {
    description: "专注模式：/focus [on|off]，无参数切换",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return;
      const value = args.trim().toLowerCase();
      if (value && value !== "on" && value !== "off") {
        ctx.ui.notify("用法：/focus [on|off]", "warning");
        return;
      }
      enabled = value ? value === "on" : !enabled;
      pi.appendEntry(key, { enabled });
      apply(ctx);
    },
  });

  pi.on("agent_start", (_event, ctx) => {
    running.clear();
    completed = failures = 0;
    lastFailure = lastFile = "";
    phase = "思考中";
    outcome = "本轮结束";
    paint(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    running.set(event.toolCallId, { name: event.toolName, args: event.args });
    paint(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const call = running.get(event.toolCallId);
    running.delete(event.toolCallId);
    completed++;
    phase = "整理结果";
    if (event.isError) {
      failures++;
      lastFailure = `${event.toolName} · ${clean(textOf(event.result)) || "执行失败"}`;
    } else if ((event.toolName === "edit" || event.toolName === "write") && call?.args?.path) {
      lastFile = clean(call.args.path);
    }
    paint(ctx);
  });
  pi.on("agent_before_settle", (event) => {
    outcome = event.outcome === "aborted" ? "已中止" : event.outcome === "error" ? "本轮出错" : "本轮结束";
  });
  pi.on("agent_settled", (_event, ctx) => {
    running.clear();
    phase = outcome;
    paint(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(key, undefined);
    if (previousExpanded !== undefined) ctx.ui.setToolsExpanded(previousExpanded);
    previousExpanded = undefined;
  });
}
