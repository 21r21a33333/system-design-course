import { describe, expect, it } from 'vitest';
import { sanitizeCardField } from './flashcards';

describe('sanitizeCardField', () => {
  it('strips style attributes and disallowed tags but keeps text and structure', () => {
    const input = '<h2 style="color:red;">Title</h2><p style="margin:0">Body <script>alert(1)</script></p>';
    const out = sanitizeCardField(input);
    expect(out).not.toContain('style=');
    expect(out).not.toContain('<script>');
    expect(out).toContain('<h2>Title</h2>');
    expect(out).toContain('Body');
  });

  it('keeps safe links but drops javascript: hrefs', () => {
    const safe = sanitizeCardField('<a href="https://example.com">link</a>');
    expect(safe).toBe('<a href="https://example.com">link</a>');
    const unsafe = sanitizeCardField('<a href="javascript:alert(1)">bad</a>');
    expect(unsafe).not.toContain('javascript:');
  });
});
