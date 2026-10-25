import { Breadcrumb } from "../../../components/Breadcrumb";
import { ModuleCard } from "../../../components/ModuleCard";
import { menuItemsByGroup } from "../../../config/menuRegistry";
import { useAccess } from "../access/useAccess";
import { ConfigBanner } from "../components/ConfigBanner";
import { configBreadcrumb } from "../components/configBreadcrumb";

export function VisaoGeral() {
  const { user, roleLabel, canOpen } = useAccess();
  const areas = menuItemsByGroup("configuracoes").filter((item) => canOpen(item.id));

  return (
    <>
      <Breadcrumb items={configBreadcrumb()} />
      <ConfigBanner userName={user?.name ?? ""} role={roleLabel} />

      <section>
        <h2 className="section-title">Áreas de configuração</h2>
        <div className="module-grid">
          {areas.map((item, index) => (
            <ModuleCard
              key={item.id}
              title={item.label}
              description={item.description ?? ""}
              icon={item.icon}
              accent="brand"
              to={item.path}
              permission={item.id}
              index={index}
            />
          ))}
        </div>
      </section>
    </>
  );
}
