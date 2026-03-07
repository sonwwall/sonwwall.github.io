---
title: 可观测性学习
abbrlink: observability-learning-2026
date: 2026-03-07T21:40:59
updated: 2026-03-07T21:40:59
tags:
  - 可观测性
  - 学习
  - 后端
categories:
  - 八股
desc: 可观测性体系学习记录，包括日志、指标与链路追踪。
---

# 可观测性学习

这两天写电商项目遇到了链路追踪和可观测性的实践，也是我第一次接触。  
简单总结一下关于这个的知识点吧。

## 可观测性基础

`可观测性 = 日志 + 指标 + 链路`

### 日志

- 看“发生了什么”
- 工具：`zap -> promtail -> loki -> grafana`

### 指标

- 看“系统整体怎么样”
- 工具：`prometheus -> grafana`

### 链路

- 看“这次请求经过了什么、哪一步慢”
- 工具：`OpenTelemetry -> OTel Collector -> Jaeger`

## 本项目链路

`client -> gateway(http) -> gateway logic -> gateway rpc client -> user-service rpc server`

### 对于链路追踪

`OpenTelemetry` 负责埋点和获取链路数据，然后把获取的数据上报给 `OTel Collector`，再由 `OTel Collector` 转发给 `Jaeger` 进行存储和展示。通过 `Jaeger` 可以看到某条链路经过哪些服务、每个服务消耗的时间，据此可以查哪个服务拖慢了时间或者哪个服务出现了异常。

### 对于指标

指标由 `Prometheus` 负责收集数据，它不是跟踪某一条链路，而是定时抓取各个服务节点暴露出来的 `metrics` 接口，负责统计这些节点一段时间内的数据并进行分析（`QPS`、`P95`、`P99` 等），然后把统计的数据提供给 `Grafana` 面板展示。

### 对于日志

普通写的日志就是直接打印到控制台或者写入文件，这里的 `Promtail` 可以从日志文件或者容器标准输出中读取日志，然后传到 `Loki` 进行保存和查询，`Loki` 还能接入 `Grafana`，用于展示日志和搜索日志信息。

---

## AI 对我项目中的可观测性总结

### 第一层：采集端（代码里做的事）

- 日志：`gateway` 和 `user-service` 用 `zap` 打结构化日志，同时写控制台和 `logs/*.log`
- 指标：`gateway` 暴露 `9092/metrics`，`user-service` 暴露 `9091/metrics`
- 链路：`gateway` 用 `hertz-contrib/obs-opentelemetry`，`user-service` 和 `RPC client` 用 `kitex-contrib/obs-opentelemetry`
- 上下文：请求进入后，`trace_id` 会沿着 `gateway -> rpc client -> user-service` 继续传递

### 第二层：采集与存储组件

- `Promtail`：采集日志文件，推到 `Loki`
- `Prometheus`：定时抓两个服务的 `metrics`
- `OTel Collector`：接收应用上报的 `trace`，再转发给 `Jaeger`
- `Loki`：存日志
- `Jaeger`：存链路
- `Grafana`：统一查日志、指标、链路

### 第三层：三个核心概念

- `Log`
  看具体发生了什么，适合查报错详情、业务上下文、错误码。
- `Metrics`
  看整体状态怎么样，适合看 `QPS`、错误率、`P95/P99`、趋势变化。
- `Trace`
  看一次请求经过了哪些服务、每一步耗时多少，适合查慢请求、跨服务调用链、系统异常位置。

### 第四层：你现在项目里的实际链路

一次 `POST /api/v1/user/login` 的链路是：

1. `HTTP` 请求进入 `gateway`
2. `gateway` 自动创建 `HTTP server span`
3. `gateway.logic.user.login` 创建 `internal span`
4. `gateway` 调 `user-service` 时自动创建 `RPC client span`
5. `user-service` 收到请求时自动创建 `RPC server span`
6. 日志里通过 `trace_id` 和这条链路关联起来
