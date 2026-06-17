# 🛠️ Mentat Developer Guide

Welcome to the development documentation for **Mentat**—your local agentic cognitive partner for Obsidian. This document serves as the single source of truth for setting up, testing, and releasing Mentat.

---

## 📦 1. Getting Started

### Prerequisites
*   **Node.js**: Version 20 or higher is recommended.
*   **Obsidian**: An installed instance for manual integration testing.

### Installation
Clone the repository and install the development dependencies:
```bash
npm install
```

### Build Commands
*   **Development Watch Mode** (automatic rebuild on changes):
    ```bash
    npm run dev
    ```
*   **Production Bundle** (compiles and minifies `main.js`):
    ```bash
    npm run build
    ```

---

## 🧪 2. Testing Framework

We use [Vitest](https://vitest.dev/) for our unit and integration tests. The testing environment is fully mocked and runs independently of any active Obsidian application.

### Test Commands
*   **Run All Tests** (recommended for CI/CD):
    ```bash
    npm run test:run
    ```
*   **Watch Mode** (runs tests interactively on file change):
    ```bash
    npm run test
    ```
*   **UI Mode** (opens a beautiful interactive visual test browser):
    ```bash
    npm run test:ui
    ```

### Mocking Environment
Obsidian classes (`TFile`, `Vault`, `Setting`, `Modal`, `Notice`, etc.) are fully mocked in [tests/utils/obsidian.mock.ts](file:///Users/zhouweipeng/Code/obsidian-mentat/tests/utils/obsidian.mock.ts) to support fast, transitive unit testing without side effects.

---

## 🧠 3. Advanced Agentic Architecture

Mentat sets itself apart from standard AI assistants with several sophisticated cognitive patterns:

### 1. Fenced Markdown Block Tool Calling (MBTC)
To avoid the "JSON Escaping Tax" (double-escaping quotes, backslashes, and newlines in large Markdown notes and LaTeX formulas), Mentat supports direct Markdown block parsing:
```markdown
```obsidian:edit_note path="Research/Quantum.md" heading="Schrodinger Equation"
The time-dependent Schrodinger equation:
$$\hat{H}\Psi(r,t) = i\hbar\frac{\partial}{\partial t}\Psi(r,t)$$
```
```
The parser dynamically captures parameters verbatim, bypassing standard JSON tool call serialization entirely.

### 2. Note Formatting Linter Guard & Buffer Transactions
Every time Mentat writes or edits a file, the `NoteLinter` scans the text to balance LaTeX equations (`$$` and `$`), code blocks, and YAML frontmatter.
*   **Atomic Transactions**: If the edited content contains formatting errors, Mentat **immediately rolls back** the file to its exact pre-write content in memory and reports the specific validation error to the LLM for self-correction.
*   **Incremental Guard**: Edits are allowed to bypass rollback if they do not increase the pre-existing error count, preventing linter deadlocks in legacy files.

### 3. Dynamic Semantic Vault Directory Tree
Instead of naive document statistics, Mentat builds a nested directory tree outline up to depth 3:
*   Counts direct and recursive Markdown files per folder.
*   Extracts the Top 3 most frequent tags per folder subtree from metadata cache.
*   Sorts directories descending by activity to highlight important domains first.

### 4. Interactive Knowledge Map (`vault-map.md`)
Mentat reads structural rules, naming conventions, and category workflows from `${userConfigFolder}/vault-map.md`. 
*   **Cold-Start Engine**: Clicking "Open Knowledge Map" in settings scans your vault, identifies your largest folders, and pre-populates `vault-map.md` with actual active directories and elegant Obsidian double-bracket guidelines.

---

## 🚀 4. Automated CI/CD & Publishing Workflow

We have a seamless local-to-cloud automated pipeline for shipping updates.

```
Local CLI (npm run bump) ---> Git Push Tags ---> GitHub Actions CD ---> Github Release Assets
```

### Local Version Bumping
To release a new version (e.g. `0.1.1`), run:
```bash
npm run bump 0.1.1
```
This local script (`scripts/bump-version.mjs`) automatically:
1.  Updates the version field in `package.json` and `manifest.json`.
2.  Syncs and packages `package-lock.json`.
3.  Creates a Git commit `chore: bump version to 0.1.1` and an annotated local tag `v0.1.1`.

### Continuous Integration (CI)
Our [ci.yml](file:///Users/zhouweipeng/Code/obsidian-mentat/.github/workflows/ci.yml) workflow runs on every push to `master` and pull request, executing the entire 137+ test suite to guarantee code stability.

### Continuous Delivery (CD)
Our [release.yml](file:///Users/zhouweipeng/Code/obsidian-mentat/.github/workflows/release.yml) workflow triggers when version tags (`v*`) are pushed to GitHub:
1.  Checks out tag, installs dependencies, and runs all unit tests.
2.  Compiles the production bundle via `npm run build`.
3.  Verifies the build outputs: `main.js`, `manifest.json`, and `styles.css`.
4.  Ensures `manifest.json` version matches the tag version exactly.
5.  Publishes a GitHub Release and uploads the three required assets automatically.

### Publishing to Obsidian Marketplace
Once the GitHub Release is built, you can submit or update the plugin by:
1.  Logging into **[community.obsidian.md](https://community.obsidian.md)**.
2.  Linking your GitHub account.
3.  Going to **Plugins** > **New plugin** and pasting your Mentat repository URL.
