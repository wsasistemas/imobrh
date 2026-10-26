import "./UserAvatar.css";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

export function UserAvatar({ name }: { name: string }) {
  return (
    <span className="user-avatar" aria-hidden="true">
      {initials(name)}
    </span>
  );
}
