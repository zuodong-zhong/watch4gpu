# Security Policy

## Supported version

安全修复仅面向默认分支的最新版本。

## Reporting a vulnerability

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私下报告问题，不要在公开 Issue 中发布漏洞细节、凭据或基础设施信息。

报告中请包含影响范围、复现条件和建议修复方式，但务必移除真实服务器地址、账号、日志中的个人信息以及任何认证材料。

## Deployment boundary

GPU Watch 设计为本地工具。本地 API 默认只监听 `127.0.0.1`，不应直接暴露到公网；远端采集账号应遵循最小权限原则，并优先使用受限 SSH key。
