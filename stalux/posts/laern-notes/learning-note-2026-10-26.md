---
title: SSE 在 AI Agent 长任务中的连接管理与状态恢复
abbrlink: learning-note-20261026
date: 2026-10-26T20:04:35
updated: 2026-10-27T09:46:36
tags:
  - 学习笔记
  - 学习
  - AI Agent
  - SSE
  - 流式通信
categories:
  - 学习笔记
desc: 以任务生命周期解耦、SSE 断线续传和页面刷新恢复为主线，整理长任务 AI Agent 的通信与状态设计。
---

# SSE 在 AI Agent 长任务中的连接管理与状态恢复

AI Agent 的一次执行可能包括模型推理、工具调用和结果整理，持续数分钟。真正难的不是持续输出文字，而是当网络中断、页面刷新或用户主动停止时，系统还能准确回答三个问题：

1. 后台任务是否还在运行？
2. 前端漏掉了哪些事件？
3. 页面怎样恢复到与服务端一致的状态？

本文围绕这三个问题，整理一套可落地的设计。

## 一、先把职责拆开

SSE 是基于 HTTP 的服务端单向推送。服务端持续返回 text/event-stream 响应，事件由空行分隔，可以携带 ID、类型和数据。

~~~text
id: 103
event: tool_call
data: {"tool":"search_logs"}

id: 104
event: delta
data: {"content":"正在整理结果"}
~~~

它适合模型输出、任务进度和日志通知。对长任务 Agent 而言，重点不是“连接永远不断”，而是**连接断开后能否重新订阅同一个任务**。

因此，创建任务、订阅事件和停止任务应是三类独立操作：

~~~text
POST /agent/runs                  创建任务，返回 run_id
GET  /agent/runs/{run_id}/events  订阅该任务的 SSE
POST /agent/runs/{run_id}/stop    显式停止任务
~~~

这样重连只会恢复订阅，不会重复执行 Agent。

## 二、场景一：刷新页面不应停止后台任务

用户刷新、关闭页面或暂时断网，只说明当前 SSE 连接结束；用户点击“停止生成”才表示想取消任务。两种行为不能共用同一个取消信号。

### 请求 Context 与任务 Context

HTTP 请求提供的 reqCtx 只管理这次 SSE Handler。浏览器断开后，Handler 可以停止写数据并释放资源。

Agent 本身要使用独立的 runCtx，并传给模型调用、工具调用和结果持久化：

~~~go
runCtx, cancel := context.WithTimeout(
    context.Background(),
    30*time.Minute,
)

go runAgent(runCtx, runID)
~~~

这样，前端连接断开不会取消后台任务。runCtx 仍要有超时、并发限制和资源清理，避免任务无限运行。

### 停止必须是显式指令

停止按钮应调用单独接口。服务端校验任务归属和状态后，再向实际执行任务的 Worker 发送取消信号：

~~~text
点击停止
  -> POST /agent/runs/{run_id}/stop
  -> 原子地把 running 改为 canceling
  -> 通知 Worker 取消
  -> Worker 写入 canceled
~~~

单实例可以临时保存 run_id 到 cancel 函数的映射；多实例不能只依赖内存，取消指令必须经由共享存储、消息队列或调度器送达正确的 Worker。

| 用户行为 | SSE 连接 | Agent 任务 |
| --- | --- | --- |
| 刷新页面、关闭标签页、临时断网 | 断开 | 继续执行 |
| 点击停止 | 主动关闭 | 显式取消 |
| 任务超时 | 可结束 | 超时取消 |
| 正常完成 | 收到终态事件后结束 | 写入 completed |

**连接生命周期与任务生命周期应解耦；取消只能由明确的业务指令触发。**

## 三、场景二：SSE 断线后如何续接

心跳只能降低空闲连接被代理关闭的概率，不能保证连接永远不断。可靠方案需要同时处理保活、重连和补发。

### 1. 心跳负责保活，不负责正确性

Agent 调用慢工具时，几分钟没有业务事件很常见。Nginx、负载均衡或 NAT 可能把这种连接当作空闲连接关闭。服务端可以周期性写入 SSE 注释：

~~~text
: ping

~~~

注释不会触发普通事件处理器，却能让连接保持活跃。心跳间隔应小于链路中最短的空闲超时，例如代理 60 秒超时，可以每 20 秒发送一次。

注意，Write 和 Flush 不表示浏览器已经收到数据，也不一定会立刻发现断网。心跳是降低断线概率的手段，不是断线恢复机制。

### 2. 用 run_id 与事件序号续传

每个可恢复事件都应在同一个任务内拥有递增序号。前端只在事件成功更新 UI 后，才记录最后已消费的 ID。

~~~text
GET /agent/runs/run_123/events?after=103
~~~

服务端补发 104 之后的历史事件，再继续推送实时事件。事件可以保存到数据库事件表、Redis Streams 或其他可按游标读取的日志；纯内存缓冲只适合单实例且接受实例重启后无法恢复的场景。

历史补发与实时订阅之间不能有空档。若先查历史、过一段时间才注册订阅，中间产生的事件会丢失。应使用统一事件日志，或先建立订阅边界再从该边界补发。

### 3. fetch 必须按 SSE 事件边界解析

网络分片边界不等于 SSE 事件边界：一次读取可能只有半条事件，也可能包含多条。正确做法是缓存文本、以空行切分完整事件，再解析字段。

~~~ts
type AgentEvent = {
  id: string;
  type: string;
  data: unknown;
};

function parseEvent(block: string): AgentEvent | null {
  let id = "";
  let type = "message";
  const dataLines: string[] = [];

  for (const line of block.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("id:")) id = line.slice(3).trimStart();
    else if (line.startsWith("event:")) type = line.slice(6).trimStart();
    else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!id && dataLines.length === 0) return null;
  const text = dataLines.join("\n");

  try {
    return { id, type, data: text ? JSON.parse(text) : null };
  } catch {
    return { id, type, data: text };
  }
}

async function consumeSse(
  url: string,
  signal: AbortSignal,
  onEvent: (event: AgentEvent) => void,
) {
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error("SSE unavailable");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (block.startsWith(":")) continue;
        const event = parseEvent(block);
        if (event) onEvent(event);
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
~~~

如果流结束前没有收到 done、failed 或 canceled 等终态事件，前端不能直接判断任务失败。应先查询任务状态：仍在运行才按指数退避重新订阅；已经结束则读取最终结果。

## 四、场景三：页面刷新后的运行态恢复

如果系统只在任务结束时一次性保存 Assistant 消息，用户在中途刷新页面后，数据库里通常只剩下用户消息，已经展示的思考步骤、工具调用和增量文本都会消失。

解决办法是为每个运行中的 run 保存快照，并使它与事件游标对应：

~~~go
type RunSnapshot struct {
    RunID     string
    Status    string
    LastSeq   int64
    Steps     []AgentEvent
    Content   string
    UpdatedAt time.Time
}
~~~

- Steps 保存必要的思考、工具调用和工具结果。
- Content 合并连续的文本增量，避免逐 token 保存。
- LastSeq 表示快照已经覆盖的最大事件序号。

页面刷新后的恢复顺序：

~~~text
读取会话历史
  -> 查找运行中的 run
  -> 加载该 run 的快照
  -> 恢复步骤和已生成文本
  -> 以 snapshot.lastSeq 重新订阅 SSE
  -> 仅消费更晚的事件
~~~

快照用于快速恢复 UI，事件日志用于精确续传，二者并不互相替代。快照与事件序号还必须来自同一个状态版本，否则可能出现正文已更新、游标却未推进的情况。

### 单实例与分布式部署

单实例可以把快照和近期事件放在内存里；前端一旦重连到另一台实例，或者 Worker 重启，内容就会丢失。

分布式场景更适合下面的分层：

~~~text
Worker 生成事件
  -> Event Store：保存可续传的增量事件
  -> Snapshot Store：保存压缩后的运行态
  -> API Server：读取两者并通过 SSE 推送
  -> Browser：恢复快照后继续消费事件
~~~

任务完成时，应先持久化最终结果与终态，再追加终态事件并广播；运行态快照可以在短暂 TTL 后清理。即使 done 恰好在网络中丢失，前端重连后仍能从持久化状态得知任务已完成。

## 五、用状态机收束边界情况

事件描述过程，状态描述任务当前阶段，不能混为一谈。tool_call 是过程事件，不是状态；SSE 流关闭也不等于任务结束。

一个足够小的状态机如下：

~~~text
queued -> running -> completed
                 -> failed
                 -> canceling -> canceled
queued -> canceled
~~~

completed、failed 和 canceled 都是终态，不能再返回 running。所有转换都应是条件更新，避免延迟到达的停止请求把已完成任务覆盖成 canceled。

~~~sql
UPDATE agent_runs
SET status = 'canceling', updated_at = NOW()
WHERE id = :run_id
  AND owner_id = :owner_id
  AND status IN ('queued', 'running');
~~~

停止接口应具备幂等性：多次停止只返回当前状态。完成路径则保持“结果、终态和终态事件”的顺序一致：

~~~text
Worker 得到最终结果
  -> 持久化结果与 completed
  -> 追加带新序号的 done 事件
  -> SSE 广播 done
~~~

## 六、结论

长任务 Agent 的可靠性不取决于一条不断开的 SSE，而取决于四个生命周期是否独立且可恢复：

| 层次 | 机制 | 解决的问题 |
| --- | --- | --- |
| 连接层 | SSE、心跳、重连 | 连接如何维持和重新建立 |
| 任务层 | 独立 runCtx、显式取消 | 断网是否误取消任务 |
| 事件层 | 序号、日志、游标 | 断线期间如何补齐事件 |
| 状态层 | 快照、持久化终态、状态机 | 刷新后如何还原正确页面 |

最终目标不是保证网络永不出错，而是让连接出错后，任务仍可正确执行，前端也能恢复到与服务端一致的状态。
