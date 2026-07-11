import { EventEmitter } from 'node:events';
import type { GameDockEvent, ConsoleLine } from '@gamedock/shared';

/** Builds a ready-to-write SSE data frame. */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * In-process event hub. Routes push events here; SSE endpoints subscribe.
 *
 * High-frequency channels (console output, job logs) hand their listeners a
 * pre-serialized SSE frame alongside the payload: serialization happens once
 * per published event instead of once per subscriber, and the routes write
 * the shared string as-is.
 */
export class EventHub {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(event: GameDockEvent): void {
    this.emitter.emit('event', event);
  }

  /** One batch per process-manager poll tick, not one emit per line. */
  publishConsole(instanceId: string, lines: ConsoleLine[]): void {
    if (lines.length === 0) return;
    this.emitter.emit(`console:${instanceId}`, lines, sseFrame(lines));
  }

  publishJobLog(jobId: string, text: string): void {
    this.emitter.emit(`joblog:${jobId}`, text, sseFrame({ text }));
  }

  onEvent(listener: (event: GameDockEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  onConsole(
    instanceId: string,
    listener: (lines: ConsoleLine[], frame: string) => void,
  ): () => void {
    const channel = `console:${instanceId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  onJobLog(jobId: string, listener: (text: string, frame: string) => void): () => void {
    const channel = `joblog:${jobId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
