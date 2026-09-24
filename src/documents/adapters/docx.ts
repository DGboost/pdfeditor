import { createFrameSession } from '../frameBridge';
import type { OfficeSession, OfficeSessionOptions } from '../officeTypes';

export function createDocxSession(options: OfficeSessionOptions): Promise<OfficeSession> {
  if (options.format !== 'docx') return Promise.reject(new Error('DOCX 세션 형식이 일치하지 않습니다.'));
  return createFrameSession(options, 'engines/docx/index.html');
}
