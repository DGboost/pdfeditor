import type { OfficeSessionOptions, OfficeSession } from '../officeTypes';
import { createFrameSession } from '../frameBridge';

export function createPptistSession(options: OfficeSessionOptions): Promise<OfficeSession> {
  return createFrameSession(options, 'engines/pptx/index.html');
}
