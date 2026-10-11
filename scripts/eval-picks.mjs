import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateSessions, formatMarkdown } from "../src/core/pick-eval.js";

const HELP = `用法：
  node scripts/eval-picks.mjs --run <runId> --fixture <file> [--run <runId> --fixture <file> ...]
  node scripts/eval-picks.mjs --config <json>
  node scripts/eval-picks.mjs --run <runId> --truth 'star>=4'

选项：
  --config <json>         会话数组 [{run, fixture}]；fixture 相对配置文件目录
  --truth <条件>         star>=N、tag=标签名、folder=文件夹id；重复条件按 AND 组合
  --budget <比例>        (0,1]，默认 0.3；可重复或逗号分隔
  --bootstrap <次数>     按组 bootstrap 次数，默认 1000
  --seed <整数>          固定随机种子，默认 42
  --random-iterations <次数> 随机基线采样次数，默认 100
  --out <file>           保存 JSON（同时输出到 stdout）
  --md <file>            保存中文 Markdown（同时输出到 stderr）
  --help                 显示帮助

run 读取当前目录 data/runs/<runId>/results.json，不重新分析。
必须显式提供带 selectedStems 的已确认真值 fixture 或 --truth；没有默认真值。
使用 truth 时，fixture 若存在只限定会话范围，精选由 truth 决定。`;

function positiveInteger(value, flag, allowZero = false) {
  if (
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) < (allowZero ? 0 : 1)
  ) {
    throw new Error(`${flag} 需要${allowZero ? "非负" : "正"}整数`);
  }
  return Number(value);
}

export function parseArgs(argv) {
  const args = {
    sessions: [],
    truth: [],
    budgets: [],
    bootstrap: 1000,
    seed: 42,
    randomIterations: 100,
  };
  const single = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (
      ![
        "--run",
        "--fixture",
        "--config",
        "--truth",
        "--budget",
        "--bootstrap",
        "--seed",
        "--random-iterations",
        "--random-trials",
        "--out",
        "--md",
      ].includes(flag)
    ) {
      throw new Error(`未知选项：${flag}（使用 --help 查看用法）`);
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
    if (!["--run", "--fixture", "--truth", "--budget"].includes(flag)) {
      if (single.has(flag)) throw new Error(`${flag} 只能指定一次`);
      single.add(flag);
    }
    switch (flag) {
      case "--run":
        if (value === "." || value === ".." || /[/\\]/.test(value))
          throw new Error("--run 必须为 runId，不能包含路径");
        args.sessions.push({ run: value });
        break;
      case "--fixture": {
        const session = args.sessions.at(-1);
        if (!session || session.fixture)
          throw new Error(
            "每个 --fixture 必须跟在对应的 --run 之后，且每个 run 只能有一个 fixture",
          );
        session.fixture = path.resolve(value);
        break;
      }
      case "--config":
        args.config = path.resolve(value);
        break;
      case "--truth":
        if (!/^(star>=\d+|tag=.+|folder=.+)$/.test(value))
          throw new Error(`无效真值条件：${value}`);
        args.truth.push(value);
        break;
      case "--budget":
        for (const part of value.split(",")) {
          const budget = Number(part);
          if (
            !part.trim() ||
            !Number.isFinite(budget) ||
            budget <= 0 ||
            budget > 1
          )
            throw new Error("--budget 需要 (0,1] 范围内的比例");
          args.budgets.push(budget);
        }
        break;
      case "--bootstrap":
        args.bootstrap = positiveInteger(value, flag);
        break;
      case "--seed":
        args.seed = positiveInteger(value, flag, true);
        break;
      case "--random-iterations":
      case "--random-trials":
        args.randomIterations = positiveInteger(value, flag);
        break;
      case "--out":
        args.out = path.resolve(value);
        break;
      case "--md":
        args.md = path.resolve(value);
        break;
    }
  }
  if (args.config && args.sessions.length)
    throw new Error("--config 不能与 --run/--fixture 同时使用");
  if (!args.config && !args.sessions.length)
    throw new Error("需要 --run 或 --config（使用 --help 查看用法）");
  args.budgets = [...new Set(args.budgets.length ? args.budgets : [0.3])];
  return args;
}

export { formatMarkdown };

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (args.config) {
    const config = JSON.parse(await readFile(args.config, "utf8"));
    if (!Array.isArray(config) || !config.length)
      throw new Error("--config 必须是非空会话数组 [{run, fixture}]");
    args.sessions = config.map((session, index) => {
      if (
        !session ||
        typeof session.run !== "string" ||
        !session.run ||
        session.run === "." ||
        session.run === ".." ||
        /[/\\]/.test(session.run)
      )
        throw new Error(`配置第 ${index + 1} 项需要合法 runId`);
      if (
        session.fixture !== undefined &&
        (typeof session.fixture !== "string" || !session.fixture)
      )
        throw new Error(`配置第 ${index + 1} 项 fixture 需要非空文件路径`);
      return {
        run: session.run,
        fixture: session.fixture
          ? path.resolve(path.dirname(args.config), session.fixture)
          : undefined,
      };
    });
  }
  const sessions = await Promise.all(
    args.sessions.map(async (session) => {
      const fixturePath = session.fixture;
      const [data, fixture] = await Promise.all([
        readFile(
          path.resolve("data", "runs", session.run, "results.json"),
          "utf8",
        ).then(JSON.parse),
        fixturePath
          ? readFile(fixturePath, "utf8").then(JSON.parse)
          : undefined,
      ]);
      return {
        run: session.run,
        data,
        fixture,
        session: fixture?.session ?? session.run,
      };
    }),
  );
  const report = evaluateSessions(sessions, {
    truth: args.truth,
    budgets: args.budgets,
    bootstrap: args.bootstrap,
    seed: args.seed,
    randomIterations: args.randomIterations,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = formatMarkdown(report);
  if (args.out) await writeFile(args.out, json);
  if (args.md) await writeFile(args.md, markdown);
  process.stdout.write(json);
  process.stderr.write(markdown);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
