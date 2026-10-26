import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { IconeIlustrativo } from "../../../components/ds/IconeColorido";
import "./Notice.css";

interface NoticeProps {
  icon: LucideIcon;
  children: ReactNode;
}

/** Aviso informativo azul no topo das telas (ex.: segredos, uma sessão por usuário). */
export function Notice({ icon: Icon, children }: NoticeProps) {
  return (
    <div className="notice" role="note">
      <IconeIlustrativo icon={Icon} size={18} />
      <div>{children}</div>
    </div>
  );
}
