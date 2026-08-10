// scripts/ingest/caseStudies.test.ts
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_DESIGN_CASE_STUDIES,
  notebookToMarkdown,
  rewriteReadmeCaseStudyLinks,
  rewriteSiblingCaseStudyLinks,
  type Notebook,
} from './caseStudies';

describe('rewriteSiblingCaseStudyLinks', () => {
  it('rewrites a relative ../<dir>/README.md link to a course doc path', () => {
    const out = rewriteSiblingCaseStudyLinks(
      'See [scaling](../scaling_aws/README.md) for more.',
      SYSTEM_DESIGN_CASE_STUDIES,
    );
    expect(out).toBe('See [scaling](/docs/case-studies/system-design/scaling-aws) for more.');
  });
});

describe('rewriteReadmeCaseStudyLinks', () => {
  it('rewrites a solutions/system_design/<dir>/README.md link to a course doc path', () => {
    const out = rewriteReadmeCaseStudyLinks(
      'See [pastebin](solutions/system_design/pastebin/README.md) for more.',
      SYSTEM_DESIGN_CASE_STUDIES,
    );
    expect(out).toBe('See [pastebin](/docs/case-studies/system-design/pastebin) for more.');
  });

  it('leaves unknown directories unchanged', () => {
    const out = rewriteReadmeCaseStudyLinks(
      'See [x](solutions/system_design/nonexistent/README.md) for more.',
      SYSTEM_DESIGN_CASE_STUDIES,
    );
    expect(out).toBe('See [x](solutions/system_design/nonexistent/README.md) for more.');
  });
});

describe('notebookToMarkdown', () => {
  it('joins markdown cells as-is and wraps code cells in a python fence', () => {
    const notebook: Notebook = {
      cells: [
        { cell_type: 'markdown', source: ['# Title\n'] },
        { cell_type: 'code', source: ['%%writefile x.py\n', 'class X:\n', '    pass\n'] },
      ],
    };
    const md = notebookToMarkdown(notebook);
    expect(md).toBe('# Title\n\n\n```python\n%%writefile x.py\nclass X:\n    pass\n\n```');
  });
});
