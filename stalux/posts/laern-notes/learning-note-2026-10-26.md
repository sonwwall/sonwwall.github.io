---
title: 学习笔记：SSE 在 AI Agent 长任务中的连接管理与状态恢复
abbrlink: learning-note-20261026
date: 2026-10-26T20:04:35
updated: 2026-10-26T20:04:35
tags:
  - 学习笔记
  - 学习
  - AI Agent
  - SSE
  - 流式通信
categories:
  - 学习笔记
desc: 系统整理 AI Agent 长任务中的任务生命周期解耦、SSE 断线续传与页面刷新后的运行态恢复方案。
---

# 学习笔记：SSE 在 AI Agent 长任务中的连接管理与状态恢复

## 一、SSE 基础及与 WebSocket 的区别

### 1. SSE 的工作原理

SSE（Server-Sent Events）是一种基于 HTTP 的服务端单向事件推送机制，适用于 AI 流式回答、任务进度通知、后台日志推送等场景。

它的工作方式是：客户端发起 HTTP 请求，服务端返回 `Content-Type: text/event-stream`，随后保持 HTTP 响应不结束，不断向响应体写入事件。

在 HTTP/1.1 中，可以通过分块传输持续返回数据；在 HTTP/2 中，则可以通过一个持续打开的 HTTP Stream 传输事件。

典型事件格式：

```
id: 1001
event: delta
data: {"content":"正在分析日志..."}

id: 1002
event: tool_call
data: {"tool":"search_logs"}

id: 1003
event: done
data: {"status":"completed"}


```

事件之间使用空行分隔。常见字段包括：

- `id`：事件标识，可用于断线续传。
- `event`：事件类型，如 `delta`、`tool_call`、`done`。
- `data`：事件内容，通常是 JSON。
- `retry`：设置浏览器原生 EventSource 的重连等待时间。

常见响应头：

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache
X-Accel-Buffering: no
```

`X-Accel-Buffering: no` 可以用于提示 Nginx 关闭响应缓冲，避免服务端已经推送数据，代理却继续缓存，导致前端迟迟收不到消息。

服务端每次写入事件后通常调用 `Flush()`，促使响应数据及时向下游传输。

需要注意，`Flush()` 不保证数据已经被浏览器接收，也不代表每次调用都会对应一个独立的 TCP 数据包。

### 2. SSE 与 WebSocket 的区别

| 对比维度 | SSE              | WebSocket       |
| ---- | ---------------- | --------------- |
| 通信方向 | 服务端到客户端单向推送      | 全双工通信           |
| 协议   | HTTP             | WebSocket       |
| 建立连接 | HTTP 请求并保持响应流    | 建立 WebSocket 会话 |
| 消息格式 | UTF-8 文本事件       | 文本或二进制帧         |
| 心跳机制 | 通常发送 SSE 注释或心跳事件 | Ping/Pong 控制帧   |
| 自动重连 | EventSource 原生支持 | 通常需要自行实现        |
| 常见场景 | AI 流式输出、任务进度     | 聊天室、实时协作、游戏     |

两者都可以长期保持连接，且都不要求持续发送业务数据。

区别在于：

**SSE 持续的是 HTTP 响应流，WebSocket 持续的是一个可以双向收发消息的通信会话。**

### 3. 为什么 AI Agent 常使用 fetch 接收 SSE？

浏览器原生的 `EventSource` 使用方便，支持自动重连和 `Last-Event-ID`。

但原生 `EventSource` 存在一些限制：

- 只能发起 GET 请求，不能直接使用 POST 携带 JSON Body。
- 不能设置自定义请求头，例如 `Authorization: Bearer ...`。
- 内置重连逻辑不一定适合复杂任务的状态管理。

因此，在需要 POST 请求体、自定义鉴权或精细控制中断行为的场景中，可以使用：

```
const response = await fetch("/agent/chat", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    message: "帮我分析系统日志"
  })
});

const reader = response.body.getReader();
```

然后通过 `TextDecoder` 增量解码并解析 SSE 事件。

需要注意，网络数据块的边界不一定等于 SSE 事件边界，不能假设每次 `reader.read()` 都恰好得到一条完整事件。

另外，**fetch 不会自动提供 EventSource 的重连机制**，需要自行实现超时、重连、事件游标恢复等逻辑。

对于耗时较长的 Agent 任务，更推荐将创建任务和订阅事件分离：

```
POST /agent/runs
        |
        | 返回 run_id
        v
后台 Agent 执行
        |
        v
GET /agent/runs/{run_id}/events
        |
        v
SSE 持续推送
```

这种设计能够避免前端重新连接时重复创建 Agent 任务。

---

## 二、场景一：如何区分页面刷新与用户主动停止？

### 1. 问题背景

假设用户启动了一次 Agent 分析任务：

```
用户提交问题
    |
    v
Agent 开始分析
    |
    v
调用多个慢工具
    |
    v
生成最终报告
    |
    v
持久化执行结果
```

整个任务可能需要 3～10 分钟。

任务执行期间，用户可能进行两种操作：

**情况 A：刷新页面或临时断网。**

用户只是断开了当前前端连接，并不希望停止后台任务。

**情况 B：点击“停止生成”。**

用户明确希望终止任务，避免继续消耗模型 Token 和计算资源。

但是，如果后端仅通过 HTTP 请求 Context 判断，两种操作都可能表现为请求取消。

例如：

```
reqCtx := r.Context()
```

当客户端连接关闭时，`reqCtx.Done()` 会被触发。

如果所有 Agent 执行逻辑都依赖 `reqCtx`，就会出现一个问题：

**用户只是刷新了页面，却导致整个后台 Agent 任务被取消。**

### 2. 解决方案：请求 Context 与任务 Context 解耦

将两个生命周期拆开：

- `reqCtx`：管理 SSE 请求与客户端连接。
- `runCtx`：管理后台 Agent 任务执行。

整体架构：

```
                  用户创建任务
                       |
                       v
                POST /agent/runs
                       |
                       v
                  创建 run_id
                       |
             +---------+---------+
             |                   |
             v                   v
         runCtx              reqCtx
       后台任务生命周期      SSE 连接生命周期
             |                   |
             v                   v
        Agent 执行           SSE 推流
             |                   |
        工具调用、LLM         前端接收事件
             |                   |
             v                   X
         持久化结果           页面刷新
             |
             v
          任务完成
```

#### reqCtx：管理 HTTP 请求生命周期

`reqCtx` 由 HTTP 服务端提供。

```
reqCtx := r.Context()

select {
case <-reqCtx.Done():
    return
}
```

当浏览器刷新、连接断开或请求被取消时，SSE Handler 可以退出并释放资源。

但这不应自动取消独立运行的后台任务。

#### runCtx：管理 Agent 任务生命周期

任务创建时，使用独立的 Context：

```
runCtx, cancel := context.WithTimeout(
    context.Background(),
    30*time.Minute,
)
```

该 Context 传递给真正执行任务的组件：

```
runCtx
  |
  +-- Agent 推理
  |
  +-- LLM 请求
  |
  +-- 工具调用
  |
  +-- 数据库查询
  |
  +-- 结果处理
```

这样，SSE 连接中断并不会影响后台任务继续执行。

但独立 Context 不意味着任务可以无限运行，需要同时具备：

- 最大执行时长限制。
- 主动取消机制。
- 并发任务数量限制。
- 执行状态管理与资源释放。
- 任务失败后的状态记录。

此外，任务级 Context 只能提供协作式取消，外部 API、SQL 查询等是否立即停止，还取决于下游组件是否正确响应取消信号。

### 3. 用户主动停止：通过独立接口显式取消

仅仅断开 SSE 连接，并不能代表用户想停止任务。

因此需要一个独立的控制接口：

```
POST /agent/runs/{run_id}/stop
```

服务端维护任务运行状态，以及对应的取消函数。

单实例场景中，可以使用类似这样的结构：

```
type Run struct {
    ID     string
    Cancel context.CancelFunc
}
```

用户点击停止时：

```
用户点击停止
      |
      v
POST /agent/runs/{run_id}/stop
      |
      v
服务端校验任务归属和状态
      |
      v
查找 run_id 对应的 cancel
      |
      v
cancel()
      |
      v
Agent 终止执行
      |
      v
更新任务状态为 canceled
```

注意，停止接口应具备幂等性，避免重复停止造成异常。

对于分布式部署，单纯保存 `run_id -> cancel` 的内存映射还不够，因为停止请求可能到达另一台服务实例。

此时可以通过任务调度器、共享任务状态或消息机制，将取消指令传递到真正执行任务的 Worker。

### 4. 最终行为

| 用户行为       | SSE 连接    | Agent 任务       |
| ---------- | --------- | -------------- |
| 刷新页面       | 断开        | 继续执行           |
| 关闭页面       | 断开        | 继续执行           |
| 临时断网       | 中断        | 继续执行           |
| 点击停止       | 主动关闭      | 显式取消           |
| 任务执行超时     | 可结束       | 超时取消           |
| Agent 正常完成 | 推送完成事件后结束 | 状态变为 completed |

核心原则：

**网络连接的生命周期与后台任务的生命周期不应强绑定；业务上的停止必须通过显式指令表达。**

---

## 三、场景二：长耗时任务如何保持 SSE 连接，以及断线后如何续接？

### 1. 问题背景

复杂 Agent 经常会执行长时间没有任何输出的操作，例如：

```
Agent 开始执行
      |
      v
thinking
      |
      v
调用工具
      |
      | 2 分钟没有输出
      |
      v
tool_result
      |
      v
继续推理
```

虽然 Agent 一直在运行，但 SSE 连接在工具执行期间可能没有任何业务数据。

中间网络设备可能存在空闲超时，例如：

- Nginx 反向代理。
- 云负载均衡器。
- NAT 网关。
- 企业防火墙。

例如，Nginx 默认的 `proxy_read_timeout` 为 60 秒。

如果服务端长时间没有向 Nginx 返回新数据，就可能触发读取超时。

此外，Wi-Fi 切换、服务器重启、浏览器休眠等也可能导致 SSE 中断。

解决这个问题，需要分别处理**连接保活**和**断线恢复**。

### 2. 第一层：服务端心跳保活

服务端设置心跳定时器，例如每 20 秒发送一次：

```
: ping


```

这是 SSE 的注释格式，客户端不会将其当作普通消息事件处理。

也可以发送具名事件：

```
event: heartbeat
data: {}


```

但这种方式需要客户端区分心跳与业务事件。

Go 示例：

```
heartbeat := time.NewTicker(20 * time.Second)
defer heartbeat.Stop()

for {
    select {
    case <-r.Context().Done():
        return

    case <-heartbeat.C:
        fmt.Fprint(w, ": ping\n\n")
        flusher.Flush()

    case event := <-eventCh:
        fmt.Fprintf(w, "data: %s\n\n", event)
        flusher.Flush()
    }
}
```

实际实现还需要处理 `eventCh` 关闭、写入错误，以及慢客户端导致的阻塞问题。

心跳的主要作用是：

1. 避免连接长时间没有数据，触发部分中间设备的空闲超时。
2. 让服务端周期性尝试写入，从而增加发现连接异常的机会。

例如：

```
Nginx 空闲超时：60 秒
SSE 心跳间隔：20 秒
```

持续发送心跳，可以降低连接由于空闲超时而被关闭的概率。

但需要注意：

**Write/Flush 不保证立即检测到连接断开。**

数据可能进入本地缓冲区后才发生网络失败，服务端也可能在后续写入或请求取消时才发现异常。

心跳也无法解决代理设置的最大连接寿命、服务器重启等问题。

### 3. 第二层：断线后自动重连

即使设置心跳，也不能保证连接永远不断。

所以前端需要明确区分：

- 正常结束：收到了 `done` 事件。
- 用户主动取消：收到了或确认了取消操作。
- 连接意外中断：没有收到终态事件，流却已经结束。

正常结束的事件可以定义为：

```
event: done
data: {"status":"completed"}


```

对于任务失败或主动取消，也应该设计独立的终态事件：

```
event: error
data: {"status":"failed"}

event: canceled
data: {"status":"canceled"}


```

这里的 `error` 是业务失败事件，不应该与所有网络连接错误混为一谈。

#### 前端状态管理

前端维护几个关键变量：

```
let runId = "";
let lastEventId = "";
let terminalReceived = false;
let userStopped = false;
```

当读取 SSE 数据时：

- 接收普通事件：更新页面与最后事件 ID。
- 接收 `done`：标记任务完成。
- 接收 `canceled`：标记任务取消。
- 接收终态失败事件：展示失败状态。
- 流异常结束：如果没有收到终态事件，则进入恢复流程。

基本判断：

```
if (!terminalReceived && !userStopped) {
    // 检查任务状态并尝试恢复订阅
}
```

不过，没有收到 `done` 不代表后台任务一定仍在运行。

例如，任务可能已经完成，但最后一帧事件在网络中丢失。

因此，**前端不能仅根据 SSE 是否断开来判断 Agent 是否完成，而应以服务端任务状态为准。**

### 4. 第三层：通过 run_id 与事件 ID 续接

在流式输出时，服务端为事件分配递增 ID：

```
id: 101
event: thinking
data: {"content":"正在分析"}

id: 102
event: tool_call
data: {"tool":"search"}

id: 103
event: delta
data: {"content":"发现异常"}


```

前端记录最近成功处理的事件 ID。

假设收到 ID 103 后断线：

```
前端                            服务端
 |                                 |
 |<------ id: 101 ------------------|
 |<------ id: 102 ------------------|
 |<------ id: 103 ------------------|
 |                                 |
 X          网络断开               |
 |                                 |
 |          产生事件 104、105       |
 |                                 |
 |---- 重新订阅 run_id ----------->|
 |     lastEventId = 103           |
 |                                 |
 |<------ id: 104 ------------------|
 |<------ id: 105 ------------------|
 |<------ id: 106 ------------------|
```

例如：

```
GET /agent/runs/run_123/events?after=103
```

如果使用原生 `EventSource`，浏览器可通过 `Last-Event-ID` 请求头携带最后事件 ID。

如果使用 `fetch`，则需要自行保存游标，并在重连时传给服务端。

服务端需要具备事件重放能力，可以使用：

- 内存事件缓存。
- Redis Streams。
- 数据库事件表。
- 其他可按游标查询的事件存储。

续传流程：

```
SSE 断开
    |
    v
前端记录 lastEventId
    |
    v
重新订阅原 run_id
    |
    v
服务端查询 run 状态
    |
    +---- running
    |        |
    |        v
    |    补发遗漏事件
    |        |
    |        v
    |    继续订阅实时事件
    |
    +---- completed
    |        |
    |        v
    |    返回最终持久化结果
    |
    +---- failed / canceled
             |
             v
         恢复终态
```

需要处理好**历史事件补发与实时事件订阅之间的竞态**。

例如，不能先查历史到 ID 105，再过一段时间才开始监听实时事件，否则中间产生的 ID 106 可能丢失。

可以通过统一事件日志游标、原子注册订阅者与补发，或者采用支持历史读取和持续消费的消息系统解决。

### 5. 重连策略

客户端不应该无限高频重试。

可以使用指数退避：

```
第一次重连：1 秒后
第二次重连：2 秒后
第三次重连：4 秒后
第四次重连：8 秒后
...
最大等待：30 秒
```

并增加随机抖动，避免大量客户端同时断线后集中重连。

多次失败后，可以提示用户网络连接异常，同时保留 `run_id`，允许后续再次恢复。

需要强调：

**重连的目标是恢复同一个任务的事件订阅，而不是重新执行 Agent。**


### 6. 完整的 fetch SSE 解析与恢复示例

使用 \`fetch\` 读取 SSE 时，必须先把网络分片拼成完整事件，再处理 \`id\`、\`event\` 与多行 \`data\`。下面的示例将连接、解析、游标记录和重连入口分开，便于接入实际状态管理。

\`\`\`ts
type AgentEvent = {
  id: string;
  type: string;
  data: unknown;
};

function parseSseBlock(block: string): AgentEvent | null {
  let id = "";
  let type = "message";
  const dataLines: string[] = [];

  for (const line of block.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) type = line.slice(6).trimStart();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }

  if (!id && dataLines.length === 0) return null;

  const dataText = dataLines.join("\n");
  let data: unknown = dataText;
  try {
    data = dataText ? JSON.parse(dataText) : null;
  } catch {
    // 某些事件可以使用纯文本 data；解析失败时保留原文。
  }
  return { id, type, data };
}

async function subscribeRun(
  runId: string,
  after: string,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const response = await fetch(
    \`/agent/runs/\${encodeURIComponent(runId)}/events?after=\${encodeURIComponent(after)}\`,
    {
      headers: { Accept: "text/event-stream" },
      signal,
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(\`SSE subscription failed: \${response.status}\`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let separator: number;
      while ((separator = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(
          separator + (buffer.startsWith("\r\n", separator) ? 4 : 2),
        );

        if (block.startsWith(":")) continue; // SSE 注释心跳
        const event = parseSseBlock(block);
        if (event) onEvent(event);
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
\`\`\`

调用方应在**成功处理事件后**才推进 \`lastEventId\`。如果事件已写入 UI 但游标尚未保存，重连后可能重复；如果游标先保存、UI 处理失败，则可能漏事件。实际项目可以让事件处理和游标写入走同一个状态更新操作。

\`\`\`ts
let lastEventId = snapshot.lastSeq?.toString() ?? "";
let terminalReceived = false;

await subscribeRun(runId, lastEventId, controller.signal, (event) => {
  applyEventToUi(event);             // 先更新页面状态
  if (event.id) lastEventId = event.id; // 再推进已消费游标

  if (["done", "error", "canceled"].includes(event.type)) {
    terminalReceived = true;
  }
});
\`\`\`

当流意外结束而 \`terminalReceived\` 为 \`false\` 时，先查询任务状态；仍在运行才按指数退避重新调用 \`subscribeRun(runId, lastEventId, ...)\`。这样既不会重新创建任务，也不会把网络中断误判为任务完成。

---

## 四、场景三：页面刷新后如何恢复之前的思考过程和工具调用记录？

### 1. 问题背景

很多 AI 系统为了减少数据库写入次数，会采用这样的持久化策略：

```
收到用户消息
      |
      v
立即保存 User 消息
      |
      v
Agent 开始执行
      |
      v
thinking / tool_call / delta
      |
      | 中间事件不写数据库
      |
      v
Agent 执行完成
      |
      v
一次性保存 Assistant 消息
```

这种设计能够减少高频数据库写入，但存在一个问题：

**任务尚未完成时，数据库里还没有完整的 Assistant 消息。**

例如 Agent 已经执行了一分钟：

```
thinking：开始分析用户需求
tool_call：查询数据库
tool_result：找到 20 条异常记录
thinking：进一步分析异常原因
delta：根据查询结果，可以发现……
```

此时用户刷新页面。

前端内存状态全部清空，重新请求会话历史时，数据库可能只有 User 消息。

于是之前展示的思考过程、工具调用卡片和已经生成的文字都会消失。

### 2. 解决方案：运行态事件缓存

为正在执行的任务维护一个 In-flight Event Cache。

整体数据流：

```
                 Agent 执行
                     |
                     v
                 产生事件
                     |
                     v
               事件处理器
                     |
           +---------+---------+
           |                   |
           v                   v
       事件缓存             SSE 推送
           |                   |
           v                   v
      保存运行态          前端实时展示
           |
           v
      页面刷新后读取
```

核心思想：

**Agent 产生的事件不仅要推送给前端，还要保留足够的运行态信息，以便刷新和重连后恢复页面。**

缓存应以 `run_id` 为主要标识，而不只是 `conversation_id`。

原因是同一个会话可能存在多次执行、重试或并发任务，仅用会话 ID 容易造成不同任务之间的数据混淆。

### 3. 缓存数据结构

可以将低频步骤事件和高频文本增量分开处理。

例如：

```
type RunSnapshot struct {
    RunID      string
    Status     string
    LastSeq    int64
    Events     []AgentEvent
    Content    string
    UpdatedAt  time.Time
}
```

其中：

- `Events`：保存思考步骤、工具调用与工具结果。
- `Content`：保存已经生成的正文。
- `LastSeq`：当前快照覆盖的最大事件序号。
- `Status`：任务当前执行状态。

也可以使用分段内容结构，避免多轮文本生成时出现顺序混乱。

### 4. 为什么要合并 delta 事件？

大模型流式输出可能产生大量碎片：

```
delta: "根据"
delta: "查询"
delta: "结果"
delta: "，"
delta: "可以"
delta: "发现"
```

如果把每个 delta 都保存为独立事件，可能造成：

- 内存占用增大。
- 事件数量膨胀。
- 刷新后需要重放大量碎片。
- 前端恢复过程复杂。

因此，可以对连续的正文增量进行合并：

```
原始事件：
delta("根据")
delta("查询")
delta("结果")
delta("，")
delta("可以")
delta("发现")

合并结果：
content = "根据查询结果，可以发现"
```

不过，**快照合并和事件续传是两个不同的问题**。

如果仅在内存中修改某个旧 delta 节点，而不保留新事件的独立序号，就可能破坏基于 `lastEventId` 的续传语义。

更合理的方案是：

- 实时事件流保持递增序号。
- 快照存储合并后的文本和关键步骤。
- 快照记录覆盖到哪个事件序号。
- 重连时先恢复快照，再消费快照之后的新事件。

这样既可以压缩内存，也可以避免重复渲染、漏字或文字顺序错乱。

### 5. 页面刷新后的恢复流程

用户刷新页面后：

```
页面重新加载
      |
      v
GET /conversations/{id}
      |
      v
查询数据库历史消息
      |
      v
检查是否存在运行中的 run
      |
      +---- 不存在
      |       |
      |       v
      |    正常展示历史消息
      |
      +---- 存在
              |
              v
         获取运行态快照
              |
              v
         恢复 thinking
         恢复 tool_call
         恢复 tool_result
         恢复已生成正文
              |
              v
         记录 snapshot.lastSeq
              |
              v
         重新订阅 SSE
              |
              v
         接收后续增量事件
```

例如返回：

```
{
  "run_id": "run_123",
  "status": "running",
  "snapshot": {
    "last_seq": 120,
    "content": "根据查询结果，可以发现",
    "events": [
      {
        "type": "thinking",
        "content": "正在分析日志"
      },
      {
        "type": "tool_call",
        "tool": "search_logs"
      },
      {
        "type": "tool_result",
        "content": "找到20条异常记录"
      }
    ]
  }
}
```

前端先恢复这份快照，再请求：

```
GET /agent/runs/run_123/events?after=120
```

后续只接收 ID 大于 120 的事件。

通过快照中的 `last_seq` 与后续事件游标，可以建立明确的数据衔接关系。

注意，快照内容和序号应来自一致的状态版本，否则可能出现正文已经更新，但序号尚未更新，或者反过来的情况。

### 6. 内存缓存的容量控制

由于 AI Agent 可能执行很长时间，需要对缓存进行限制。

例如：

| 数据类型        | 建议策略            |
| ----------- | --------------- |
| thinking    | 按顺序保存必要步骤       |
| tool_call   | 保留工具名称、参数摘要     |
| tool_result | 保存结果摘要，完整结果按需另存 |
| delta       | 合并连续文本          |
| 事件数量        | 设置上限，如 200 条    |
| 单任务缓存       | 设置大小上限，如 256 KB |
| 任务结束后的缓存    | 设置短期保留时间并清理     |

这里的 200 条、256 KB 只是示例配置，需要根据真实任务长度和前端展示需求调整。

缓存达到上限时，不能简单丢弃所有旧事件，否则可能导致断点续传缺失。

可以通过快照压缩、持久化存储、事件过期提示等机制处理。

### 7. 任务完成后如何清理缓存？

理想流程：

```
Agent 执行完成
      |
      v
持久化完整执行结果
      |
      v
更新任务状态 completed
      |
      v
发布 done 事件
      |
      v
保留短期恢复窗口
      |
      v
清理运行态缓存
```

不建议任务一完成就立刻清空所有运行态信息。

因为可能发生：

1. 后端成功保存结果。
2. 后端尝试推送 `done`。
3. 前端恰好断网，没有收到 `done`。
4. 前端重新连接。

如果服务端已经清理所有运行态缓存，仍然需要能够通过持久化任务状态和结果告诉前端：任务实际上已经完成。

因此：

- 完整结果和终态应持久化。
- 运行态缓存可以设置 TTL 后清理。
- 重连时优先确认任务状态，再决定是补发事件还是返回最终结果。

### 8. 单实例与分布式部署的区别

内存缓存适合单实例服务，结构简单，读写速度快。

但在多实例部署时存在局限：

```
前端第一次连接 -> 实例 A
                       |
                       v
                  内存缓存 A

前端刷新重连 -> 实例 B
                       |
                       v
                  无法读取缓存 A
```

如果任务所在实例崩溃，纯内存缓存也会丢失。

因此，分布式场景可以考虑：

- Redis 保存运行态快照。
- Redis Streams 保存近期事件日志。
- 数据库保存最终消息和任务终态。
- Worker 负责执行任务，API 实例负责订阅与推送。

例如：

```
                    Agent Worker
                         |
                         v
                    事件生产
                         |
             +-----------+-----------+
             |                       |
             v                       v
       Redis Streams           Redis Snapshot
       增量事件记录            运行态快照
             |                       |
             +-----------+-----------+
                         |
                         v
                     API Server
                         |
                         v
                       SSE
                         |
                         v
                       前端
```

这里 Redis Streams 用于提供可按游标读取的事件历史，Snapshot 用于快速恢复页面状态。

两者需要设计一致的事件序号或版本机制，避免出现快照与事件日志不一致的问题。


### 9. 任务状态机与状态转换

SSE 事件描述“发生了什么”，任务状态描述“当前处于什么阶段”。两者不要混用：例如 \`tool_call\` 是过程事件，不等于状态；网络流关闭也不等于任务结束。

可以先定义一组足够小、可持久化的状态：

\`\`\`text
queued -> running -> completed
                 -> failed
                 -> canceling -> canceled
queued -> canceled
\`\`\`

其中：

- \`queued\`：任务已创建，等待 Worker 接手。
- \`running\`：Agent、模型调用或工具调用正在执行。
- \`canceling\`：已收到停止指令，正在等待下游协作式取消。
- \`completed\`、\`failed\`、\`canceled\`：终态，后续不能再回到 \`running\`。

服务端应以条件更新保证转换合法，避免“任务已经完成，却被一个延迟到达的停止请求改成 canceled”：

\`\`\`sql
UPDATE agent_runs
SET status = 'canceling', updated_at = NOW()
WHERE id = :run_id
  AND owner_id = :owner_id
  AND status IN ('queued', 'running');
\`\`\`

停止接口返回幂等结果即可：若状态已是 \`canceling\` 或 \`canceled\`，直接返回当前状态；若已经 \`completed\`、\`failed\`，则告知任务已经结束，不能倒退转换。

一次可靠的完成路径应遵循下面顺序：

\`\`\`text
Worker 得到最终结果
  -> 在同一持久化边界写入结果与 completed
  -> 追加终态事件（带新序号）
  -> SSE 广播 done
\`\`\`

这样即使 \`done\` 在传输中丢失，前端重新订阅时也能通过任务状态和持久化结果恢复终态。对于多 Worker 环境，还应为同一个 \`run_id\` 设置唯一执行权，防止重试或消息重复投递导致两个 Worker 同时推进状态。

---

## 五、三个场景如何组成完整的系统？

三个问题实际上是互相关联的。

**场景一解决：连接断开后，任务要不要继续运行？**

通过 `reqCtx` 和 `runCtx` 解耦，让后台任务能够独立于 SSE 连接执行。

**场景二解决：任务还在运行，前端如何继续接收事件？**

通过心跳、自动重连、`run_id` 和事件游标，重新建立事件订阅并补发遗漏的数据。

**场景三解决：用户刷新页面以后，之前的生成内容如何恢复？**

通过运行态快照，恢复已产生的思考步骤、工具调用和正文，再衔接后续增量事件。

最终整体架构：

```
                      前端
                       |
           +-----------+-----------+
           |                       |
           v                       v
      创建/停止任务             SSE 事件订阅
           |                       |
           v                       v
       控制接口                SSE Handler
           |                       |
           v                       v
       Task Manager              reqCtx
           |
           v
         runCtx
           |
           v
       Agent Worker
           |
           v
       产生执行事件
           |
           v
        Event Store
           |
     +-----+------+------------+
     |            |            |
     v            v            v
  事件日志      运行态快照     SSE 广播
     |            |            |
     +------------+------------+
                  |
                  v
           前端重连与恢复

任务执行完成
      |
      v
持久化结果和终态
      |
      v
发送 done
      |
      v
延迟清理运行态缓存
```

### 完整执行流程

1. 前端创建任务，服务端生成唯一 `run_id`，启动独立的 `runCtx`。
2. 前端订阅该任务的 SSE 流，接收 `thinking`、`tool_call`、`delta` 等事件。
3. 服务端定时发送心跳，减少空闲连接被代理关闭的概率。
4. Agent 运行过程中持续维护事件日志与运行态快照。
5. 如果前端断网，`reqCtx` 取消，但 `runCtx` 继续执行。
6. 前端恢复连接后，携带 `run_id` 和最后处理的事件 ID，补发遗漏事件。
7. 如果用户刷新页面，先读取运行态快照，再从快照的事件游标继续订阅。
8. 如果用户主动点击停止，调用独立的停止接口，取消 `runCtx`。
9. Agent 正常完成后持久化最终结果和任务状态，发送 `done` 事件。
10. 服务端在保留必要恢复窗口后，清理运行态缓存和任务资源。

## 六、核心总结

一个可靠的长任务 AI Agent 系统，不能只考虑 SSE 如何持续输出数据，还必须考虑**连接、任务、事件和状态的生命周期管理**。

可以把整体设计概括为四层：

| 层次  | 核心机制                    | 解决的问题         |
| --- | ----------------------- | ------------- |
| 连接层 | SSE + 心跳 + 重连           | 连接如何维持及恢复     |
| 任务层 | reqCtx/runCtx 解耦 + 显式取消 | 网络断开是否影响任务    |
| 事件层 | 事件 ID + 日志 + 增量续传       | 断线期间的事件如何恢复   |
| 状态层 | 运行态快照 + 最终持久化           | 页面刷新后如何还原执行过程 |

**最终目标不是让 SSE 永远不断，而是让 SSE 即使断开，也不影响后台任务正确执行，并且让前端能够恢复到正确的任务状态。**

还需要明确一点：以上方案主要解决前端连接中断和页面刷新问题。如果希望 Worker 进程崩溃、服务实例重启后也能恢复尚未完成的 Agent 执行，还需要进一步设计持久化任务调度、检查点和可恢复执行机制；仅仅将 `runCtx` 与 `reqCtx` 解耦是不够的。
