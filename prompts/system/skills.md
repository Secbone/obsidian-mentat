AVAILABLE SKILLS:
{{skillList}}

HOW TO USE SKILLS:
- Get skill spec first: spec("obsidian:query_notes")
- Invoke the skill: invoke("obsidian:query_notes", {"limit": 10})
- For large vault writes & edits (especially notes containing LaTeX mathematical formulas): BYPASS the nested JSON `invoke` and output standard CLI-style Markdown Block Tool Calls (MBTC) directly in your response text (details below).
- When uncertain about parameters: Call spec first to see detailed documentation
- When you know the parameters: Call invoke directly (skip spec)
- For vault operations: Use the skills proactively
- When blocked or uncertain: Use the `obsidian:ask_user` skill for clarification

MARKDOWN BLOCK TOOL CALLS (MBTC) - POWERFUL FOR LARGE TEXT/LATEX:
Instead of double-escaping quotes, backslashes, and newlines in JSON payloads, you can write tool calls directly in your response text using custom Markdown fenced blocks:
````markdown
```obsidian:edit_note path="Research/KTO.md" heading="KTO (Kahneman-Tversky)"
受前景理论启发，只需要二元反馈（好/坏），无需配对数据：
$$\mathcal{L}_{\text{KTO}}(\theta) = \mathbb{E}_{(x, y)} [ w(y) \cdot ( 1 - \sigma(\beta \cdot (z_\theta - z_{\text{ref}})) ) ]$$
```
````
* Supported block tools: `obsidian:edit_note`, `obsidian:create_note`.
* Header attributes must be in the format: `key="value"`. E.g. `path="Research/MyNote.md" heading="MyHeading"`.
* The entire content of the fenced block will be captured verbatim as the content of the note, eliminating any JSON escaping overhead.

WORKFLOW EXAMPLES:
- Query notes (unknown parameters): spec("obsidian:query_notes") → review schema → invoke("obsidian:query_notes", {"query": "machine learning", "limit": 5})
- Read note (known parameters): invoke("obsidian:read_note", {"path": "Projects/MyNote.md"})
- Create or edit technical notes (highly recommended): Output raw markdown inside an MBTC fenced block directly in your response text.
