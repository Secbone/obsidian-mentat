import { describe, it, expect } from 'vitest';
import { NoteLinter } from '../../src/utils/note-linter';

describe('NoteLinter Syntax Validator', () => {
  it('should pass validation for clean, valid Markdown documents', () => {
    const content = `---
author: latte
tags: [retrieval, RAG]
version: 1.0
---

# BGE 检索技术记录

这里是普通的段落，包含一个行内公式：$x_{l+1} = x_l + \\mathcal{F}(x_l, W_l)$。

还有另一个双链链接到 [[BGE 检索]] 笔记中。

我们还有一个块级 LaTeX 公式：
$$
y_l = h(x_l) + \\mathcal{F}(x_l, W_l)
$$

下面是一段代码块：
\`\`\`python
def example():
    print("Hello world")
\`\`\`

普通的美元符号，比如物品价格为 $100 美元，不应该触发公式平衡报错。
`;

    const result = NoteLinter.validate(content);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should intercept unclosed YAML Frontmatter', () => {
    const content = `---
author: latte
tags: [retrieval]
# Missing closing ---

# Page content here
`;

    const result = NoteLinter.validate(content);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain("YAML Frontmatter is opened with '---' at the top but never closed with a matching '---' line.");
  });

  it('should intercept malformed YAML Frontmatter syntax', () => {
    const content = `---
author: latte
this line has no colon or list item
---

# Page content
`;

    const result = NoteLinter.validate(content);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("YAML Frontmatter syntax error at line 3");
  });

  it('should intercept unclosed Markdown code blocks', () => {
    const content = `
# Header

\`\`\`python
def incomplete_function():
    pass
# Missing closing backticks
`;

    const result = NoteLinter.validate(content);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("Markdown code block is opened with ``` (line 4) but never closed.");
  });

  it('should intercept unclosed LaTeX block equations ($$)', () => {
    const content = `
# Formula Page

$$
x_l + \\mathcal{F}(x_l)
# Missing closing block equation
`;

    const result = NoteLinter.validate(content);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("LaTeX block equation '$$' is opened but never closed.");
  });

  it('should intercept unbalanced LaTeX inline equations ($) in a paragraph', () => {
    const content = `
# Inline Formula Page

我们这有一个未闭合的行内公式 $x_l 是未闭合的。

但这里的价格 $100 元，以及 $200 元是不应该报错的。
`;

    const result = NoteLinter.validate(content);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("LaTeX inline equation '$' is unbalanced in paragraph");
  });

  it('should intercept unbalanced Obsidian Wikilinks', () => {
    const content = `
# Links Page

这里有 [[BGE 检索 链接，但少写了右边的括号。
`;

    const result = NoteLinter.validate(content);
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("Obsidian wikilinks are unbalanced");
  });

  it('should pass validation on Markdown tables with complex numeric math ranges and currencies', () => {
    const content = `
# Hyperparameter Note
Here is a technical comparison table.

| Parameter | Recommended Range | Description |
|-----------|-------------------|-------------|
| $\\beta$ | $0.01 \\sim 0.10$ | Controls risk aversion post-SFT |
| $\\lambda_D, \\lambda_U$ | 默认 $1$ | Balanced default values |
| Price | $100 | Default target budget |
| Loss | $\\mathcal{L} \\in [1, 3/2]$ | Mathematical bounded loss |
`;

    const result = NoteLinter.validate(content);
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
