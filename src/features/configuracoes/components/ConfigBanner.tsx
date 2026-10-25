import { Settings } from "lucide-react";
import "./ConfigBanner.css";

interface ConfigBannerProps {
  userName: string;
  role: string;
}

export function ConfigBanner({ userName, role }: ConfigBannerProps) {
  return (
    <div className="config-banner">
      <div className="config-banner__icon">
        <Settings size={22} aria-hidden="true" />
      </div>
      <div>
        <h1>Configurações</h1>
        <p className="config-banner__user">
          {userName} · {role}
        </p>
        <p className="config-banner__note">Você vê apenas as áreas liberadas para o seu perfil</p>
      </div>
    </div>
  );
}
