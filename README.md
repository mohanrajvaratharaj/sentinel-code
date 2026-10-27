# SentinelCode 🛡️

> An open-source AI code verification and security audit agent designed to catch hallucinated dependencies, logic flaws, and security anti-patterns in AI-generated pull requests.

## Why SentinelCode?
As developers increasingly rely on AI coding assistants, unverified code ("vibe coding") introduces hidden supply-chain risks, insecure dependency hallucinations, and memory leaks. SentinelCode acts as an automated security layer inside your CI/CD pipeline to audit AI-heavy codebases before merging.

## Core Features
* **Hallucinated Package Detection:** Cross-references imported packages against real registry ecosystems (PyPI, npm) to block malicious typosquatting or fake AI-generated libraries.
* **AI Anti-Pattern Scanner:** Spots hardcoded secrets, unsafe deserialization, and missing input sanitization common to LLM code generation.
* **Automated Remediation:** Generates security patches and context-aware unit tests directly within PR comment threads.

## License
Distributed under the **MIT License**. See `LICENSE` for more information.
