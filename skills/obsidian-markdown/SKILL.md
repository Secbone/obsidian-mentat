---
name: obsidian-markdown
description: Guide for Obsidian Flavored Markdown syntax and best practices
metadata:
  version: "1.0.0"
  author: mentat
  tags: [obsidian, markdown, syntax]
  executable: false
  category: documentation
---

# Obsidian Flavored Markdown

This guide covers the essential syntax for creating and editing Obsidian notes.

## Basic Markdown Syntax

### Headers
```markdown
# H1 Header
## H2 Header
### H3 Header
#### H4 Header
##### H5 Header
###### H6 Header
```

### Text Formatting
```markdown
**Bold text**
*Italic text*
***Bold and italic***
~~Strikethrough~~
==Highlight==
```

### Lists
```markdown
- Unordered list item
- Another item
  - Nested item
  - Another nested item

1. Ordered list item
2. Second item
   1. Nested ordered item
   2. Another nested item

- [ ] Task item
- [x] Completed task
```

## Obsidian-Specific Syntax

### Internal Links (Wikilinks)
```markdown
[[Note Name]]                    # Link to a note
[[Note Name|Display Text]]       # Link with custom text
[[Note Name#Heading]]            # Link to a heading
[[Note Name#^block-id]]          # Link to a block
```

### Embedding Content
```markdown
![[Note Name]]                   # Embed entire note
![[Note Name#Heading]]           # Embed specific section
![[image.png]]                   # Embed image
![[document.pdf]]                # Embed PDF
```

### Tags
```markdown
#tag                             # Simple tag
#nested/tag                      # Nested tag
#multi-word-tag                  # Multi-word tag
```

### Callouts
```markdown
> [!note]
> This is a note callout

> [!tip]
> This is a tip callout

> [!warning]
> This is a warning callout

> [!important]
> This is an important callout

> [!info]
> This is an info callout

> [!quote]
> This is a quote callout

> [!example]
> This is an example callout
```

Callouts can be foldable:
```markdown
> [!note]- Folded by default
> Content here

> [!tip]+ Expanded by default
> Content here
```

### Code Blocks
````markdown
```javascript
function hello() {
  console.log("Hello, world!");
}
```

```python
def hello():
    print("Hello, world!")
```
````

### Frontmatter
YAML frontmatter at the top of a note:
```markdown
---
title: My Note
tags: [project, important]
created: 2025-01-20
author: John Doe
---

Note content starts here...
```

### Block References
```markdown
This is a paragraph ^block-id

Reference it elsewhere: ![[Note#^block-id]]
```

### Math
```markdown
Inline math: $E = mc^2$

Block math:
$$
\frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$
```

### Tables
```markdown
| Header 1 | Header 2 | Header 3 |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |
```

### Comments
```markdown
%% This is a comment and won't be rendered %%
```

### Footnotes
```markdown
Here's a sentence with a footnote[^1].

[^1]: This is the footnote content.
```

## Best Practices

1. **Use Wikilinks for internal references**: Always use `[[Note Name]]` format for linking to other notes
2. **Add frontmatter for metadata**: Include tags, dates, and other metadata in YAML frontmatter
3. **Use callouts for important information**: Leverage callouts to highlight key points
4. **Keep file names simple**: Use clear, descriptive names without special characters
5. **Organize with folders and tags**: Use both folder structure and tags for organization
6. **Block references for precision**: Use block IDs when you need to reference specific paragraphs
7. **Embed for context**: Use `![[]]` to embed content when you want to show it inline

## Common Patterns

### Daily Note
```markdown
---
date: 2025-01-20
tags: [daily-note]
---

# Daily Note - 2025-01-20

## Tasks
- [ ] Task 1
- [ ] Task 2

## Notes
- Important meeting with [[Person Name]]
- Read [[Article Title]]

## Reflections
Today I learned...
```

### Project Note
```markdown
---
title: Project Alpha
status: in-progress
start-date: 2025-01-01
tags: [project, work]
---

# Project Alpha

## Overview
Brief description of the project.

## Goals
- Goal 1
- Goal 2

## Resources
- [[Resource 1]]
- [[Resource 2]]

## Next Steps
- [ ] Action item 1
- [ ] Action item 2
```

### Meeting Notes
```markdown
---
title: Weekly Team Meeting
date: 2025-01-20
attendees: [[Person 1]], [[Person 2]]
tags: [meeting, team]
---

# Weekly Team Meeting - 2025-01-20

## Agenda
1. Project updates
2. Blockers
3. Next week planning

## Discussion
- [[Person 1]] mentioned...
- Decision: We will...

## Action Items
- [ ] [[Person 1]]: Complete task X
- [ ] [[Person 2]]: Review document Y
```
