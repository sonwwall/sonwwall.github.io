---
title: 电商项目构想
abbrlink: ecommerce-project-concept-2026
date: 2026-03-03T17:34:00
updated: 2026-03-03T17:34:00
tags:
  - 电商
  - 项目
  - 构想
categories:
  - daily
desc: 一个围绕求职与实战的电商项目构想与落地计划。
---

# 电商项目构想
前面说很久没写项目了，现在需要写一个项目练练手  
目前想做一个微服务的电商项目，项目比较经典，主要也是练一下手和再熟悉一下项目架构，并且使用一些新的技术栈  
想使用的技术栈：

| 模块 | 规划 |
| --- | --- |
| 微服务框架 | kitex |
| 网络框架 | hz |
| 数据库 | mysql，redis，postgresql |
| ORM | Gorm |
| 认证/权限 | jwt，casbin |
| 消息队列 | kafka |
| 网关 | traefik |
| 部署方式 | docker compose，k8s |
| 可观测性 | Prometheus，Grafana（看板），Loki（收集日志），zap，OpenTelemetry+Jaeger（链路追踪） |
| 搜索 | Elasticsearch（用于商品的各种操作） |
| 配置管理 | viper，apollo（上线）|
| 服务发现 | etcd |

  
  一些其他想学习的技术  
  - 分布式事务 ，定时任务用corn（后续上k8s用CronJob）
  - 安全封控（限流，防刷，验证码等）
  - 乐观锁，悲观锁
  - golang-migrate

    
后面想到什么再说吧，不少技术栈还没用过