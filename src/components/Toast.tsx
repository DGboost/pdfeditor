export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      style={{
        position: 'absolute', bottom: 28, left: '50%', transform: 'translateX(-50%)',
        background: 'var(--pdfe-toast-bg, #17171a)', color: '#fff', padding: '11px 20px', borderRadius: 8,
        fontSize: 13, fontWeight: 500, animation: 'pdfe-toast-in .18s ease-out', zIndex: 60,
      }}
    >
      {message}
    </div>
  );
}
