import { EventEmitter } from 'node:events';
import type { GameDockEvent, ConsoleLine } from '@gamedock/shared';

/**
 * In-process event hub. Routes push events here; SSE endpoints subscribe.
 */
export class EventHub {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(event: GameDockEvent): void {
    this.emitter.emit('event', event);
  }

  publishConsole(instanceId: string, line: ConsoleLine): void {
    this.emitter.emit(`console:${instanceId}`, line);
  }

  publishJobLog(jobId: string, text: string): void {
    this.emitter.emit(`joblog:${jobId}`, text);
  }

  onEvent(listener: (event: GameDockEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  onConsole(instanceId: string, listener: (line: ConsoleLine) => void): () => void {
    const channel = `console:${instanceId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }

  onJobLog(jobId: string, listener: (text: string) => void): () => void {
    const channel = `joblog:${jobId}`;
    this.emitter.on(channel, listener);
    return () => this.emitter.off(channel, listener);
  }
}
