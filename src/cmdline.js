// /命令的统一格式
//
// 全项目只有这里规定「一条 /命令 长什么样」。别处不要再自己切字符串、拼回退分支。
//
// 格式：
//     [@机器人]... /主命令 [子命令|参数]...
//
// 规则：
//   1. 命令必须从「@ 之后」的位置开始：前面只允许空白和若干个 @。
//      所以「那个 /help 我看过了」不会被误当成命令。
//   2. 命令前面的 @ 里，**只有指向我们自己机器人的才算「指名」**；
//      @ 一个真人不会影响命令是否执行（群里常见「@某人 /help」）。
//   3. 第一个被指名的机器人是**执行者**：群里有两个号时只有它响应，
//      另一个保持沉默（否则一个命令会得到两份回复）。
//      指名名单整体也交给命令自己用——比如 /spendtrend 靠它挑统计哪几个号。
//   4. 命令**之后**的 @ 一律是普通参数，以 @名字 的形式并进参数里。
//   5. 参数按空格切分：第一个是子命令名，其余是它的参数。
//   6. 一个都没指名时 targets 为空 = 不限定执行者
//      （群里所有号都响应，私聊里本来也只有一个号）。
//
// 为什么按「消息段」解析而不是拼好的文本：段的顺序才是权威的。
// 文本是各段拼起来的，@ 的名字、图片占位都在里面，靠文本反推 @ 的位置容易出错。

export const DEFAULT_PREFIXES = ['/', '／'];

const blank = (s) => String(s ?? '').trim() === '';

/**
 * 解析命令行。返回 null 表示这条消息不是命令。
 *
 * @param {Array} segments 原始消息段（normalizeEvent 里的 event.message）
 * @param {object} opts
 *   prefixes  命令前缀，默认 / 和 ／
 *   isBot(qq) 这个 QQ 是不是我们自己的机器人。默认都不是（于是没人被指名）
 * @returns {null | { raw, prefix, targets, responder, name, args, argText }}
 */
export function parseCommandLine(segments, { prefixes = DEFAULT_PREFIXES, isBot = () => false } = {}) {
  const targets = [];
  let head = null;          // 命令本体（从前缀开始的那一段文本）
  const tail = [];          // 命令之后的片段（文本与 @占位）

  for (const seg of segments ?? []) {
    if (seg?.type === 'at') {
      const qq = String(seg.data?.qq ?? '').trim();
      if (head === null) {
        // 还在命令之前：只有指向自己机器人的 @ 才算指名
        if (qq && qq !== 'all' && isBot(qq)) targets.push(qq);
        continue;
      }
      // 占位后面补一个空格：@ 段本身不带空白，连着写两个就会粘成「@a@b」，
      // 参数切分就断了。（文本段自己的空白照原样保留，所以不会多出可见空格）
      tail.push(`@${String(seg.data?.name ?? '').trim() || qq || '某人'} `);
      continue;
    }
    if (seg?.type !== 'text') continue;      // 图片、语音之类不影响命令判定

    const t = String(seg.data?.text ?? '');
    if (head === null) {
      if (blank(t)) continue;                // 前缀前的空白段，跳过
      const trimmed = t.replace(/^\s+/, '');
      if (!prefixes.some((p) => trimmed.startsWith(p))) return null;   // 命令前出现正文 → 不是命令
      head = trimmed;
      continue;
    }
    tail.push(t);
  }

  if (head === null) return null;

  const body = head + tail.join('');
  const prefix = prefixes.find((p) => body.startsWith(p));
  const tokens = body.slice(prefix.length).split(/\s+/).filter(Boolean);
  const name = tokens[0] ?? '';
  if (!name) return null;                    // 只有一个斜杠，不算命令

  return {
    raw: body.trim(),
    prefix,
    targets,                                 // 命令前 @ 到的机器人 QQ，按出现顺序
    responder: targets[0] ?? null,            // 该由哪个机器人执行；null = 不限定
    name,
    args: tokens.slice(1),
    argText: tokens.slice(1).join(' '),
  };
}
