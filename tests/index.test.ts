import { afterEach, describe, expect, it, vi } from 'vitest';
import wordpress from '../src';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');

  return {
    default: {
      ...actual,
      existsSync: (path: string) => ['wp-content'].includes(path) || actual.existsSync(path),
    },
  };
});

describe('wordpress-vite-plugin', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('handles missing configuration', () => {
    /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
    /* @ts-ignore */
    expect(() => wordpress()).toThrowError('wordpress-vite-plugin: missing configuration');

    /* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
    /* @ts-ignore */
    expect(() => wordpress({})).toThrowError('wordpress-vite-plugin: missing configuration for "input".');
  });
});
