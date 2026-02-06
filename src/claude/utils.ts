import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Pushable } from './types.js';

/**
 * Creates a pushable stream that can be used to send messages to Claude Code
 */
export function createPushable<T>(): Pushable<T> & AsyncIterable<T> {
  const queue: T[] = [];
  let resolve: ((value: IteratorResult<T>) => void) | null = null;
  let ended = false;

  const pushable: Pushable<T> & AsyncIterable<T> = {
    push(value: T) {
      if (ended) return;
      if (resolve) {
        resolve({ value, done: false });
        resolve = null;
      } else {
        queue.push(value);
      }
    },
    end() {
      ended = true;
      if (resolve) {
        resolve({ value: undefined as unknown as T, done: true });
        resolve = null;
      }
    },
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<T>> {
          if (queue.length > 0) {
            // biome-ignore lint/style/noNonNullAssertion: queue.length check guarantees element exists
            return { value: queue.shift()!, done: false };
          }
          if (ended) {
            return { value: undefined as unknown as T, done: true };
          }
          return new Promise((res) => {
            resolve = res;
          });
        },
      };
    },
  };

  return pushable;
}

/**
 * Creates a user message for Claude Code
 */
export function createUserMessage(text: string, sessionId: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  };
}

/**
 * Creates a slash command message
 */
export function createSlashCommandMessage(
  command: string,
  args: string | undefined,
  sessionId: string
): SDKUserMessage {
  const text = args ? `/${command} ${args}` : `/${command}`;
  return createUserMessage(text, sessionId);
}
