import { TEXT, PANEL_SHADOW } from '../styles/theme';

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="pdfe-toast"
      style={{
        position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)',
        background: TEXT, color: '#fff', padding: '12px 20px', borderRadius: 24, maxWidth: 'calc(100% - 40px)', boxShadow: PANEL_SHADOW,
        fontSize: 13, lineHeight: 1.5, fontWeight: 500, animation: 'pdfe-toast-in .18s ease-out', zIndex: 60,
      }}
    >
      {message}
    </div>
  );
}
