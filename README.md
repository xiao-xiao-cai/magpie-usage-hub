# Magpie Usage Hub

Magpie Usage Hub 在中心 Magpie Web 看板查询多台设备的用量明细。Windows 使用 Magpie 自带的 OTLP 导出，通过 WireGuard 主动发送。Usage Hub 安装在 Docker 中心，接收并保存这些记录。

`0.7.0` 是原生 OTLP 接入候选，安装后默认停用。核对基线为 Magpie `v0.1.4799`。[原生 OTLP 验收](docs/08-开发阶段与验收计划.md#原生-otlp-接入验收)

## 功能

- **原生 OTLP 上报。** 在中心登记每台 Windows 的令牌摘要，在 Windows Magpie 的「可观测性」设置中填入中心地址与请求头。本机网关保持回环。中心本机用量通过自己的回环网关采集。[Windows 上报配置](docs/07-部署接入与运行维护.md#windows-上报配置)
- **按原调用时间查询。** 按来源、模型、预设或自定义区间查看小时或日趋势和分页明细。中心收妥的历史在来源离线时仍可查。Windows 原生 OTLP 有有限重试，耗尽的批次和启用前的历史不会自动补齐。[统计口径](docs/04-网关接口与用量数据规范.md#怎样解释中心统计) · [故障恢复](docs/05-同步流程与故障恢复设计.md)

## 安装与试用

### 在 Docker 中心安装

从项目根目录执行 `npm pack --ignore-scripts` 生成 `magpie-usage-hub-0.7.0.tgz`。在 Docker 中心的持久卷解包，再用容器内的路径注册带 `package.json` 的包目录。[中心安装与接收](docs/07-部署接入与运行维护.md#中心安装与接收)

```sh
magpie plugin add /config/plugins/usage-hub/package
```

既有部署切换前备份包、配置和中心数据库。[升级与回退](docs/07-部署接入与运行维护.md#升级与回退)

### 配置来源与中心

1. 在中心将接收端口发布到服务器的 WireGuard 地址。在插件页勾选「启用 OTLP 接收与看板」，保存后打开用量看板。[中心安装与接收](docs/07-部署接入与运行维护.md#中心安装与接收)
2. 在 Windows 生成独立的上报令牌，并在中心看板的「来源管理」登记其 SHA-256 摘要。[令牌与 Windows 配置](docs/07-部署接入与运行维护.md#windows-上报配置)
3. 在 Windows Magpie 的「设置 → 可观测性」选择 OTLP，填写中心 WireGuard 地址和 `Authorization` 请求头，选择仅元数据，开启导出。新产生用量后在中心核对「最近接收」和明细。[Windows 上报配置](docs/07-部署接入与运行维护.md#windows-上报配置)

## 文档

- 部署、权限与升级回退见[部署接入与运行维护](docs/07-部署接入与运行维护.md)。
- 配置字段、来源管理和运行状态见[配置与诊断页面设计](docs/06-配置与诊断页面设计.md)。
- OTLP 重试、中心本机游标和备份恢复见[同步流程与故障恢复设计](docs/05-同步流程与故障恢复设计.md)。
- 功能范围和开发参考见[功能规格与文档索引](docs/01-插件定位与功能规格.md)。
