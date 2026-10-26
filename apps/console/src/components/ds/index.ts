// Design system do Console do RH (herdado do imobdesk). Estilos sob .ds; cores só por tokens --ds-* (src/index.css).
import "./ds.css";
import "./components.css";

export { AlertBanner } from "./AlertBanner";
export { DetailBody, DetailDialog } from "./DetailDialog";
export { FilterSelect, type FilterOption } from "./FilterSelect";
export { KpiCard, type KpiVariant } from "./KpiCard";
export { PageHeading } from "./PageHeading";
export { Panel, PanelHeader } from "./Panel";
export { Pill, type PillTone } from "./Pill";
export { ScopeSegmented, type SegmentOption } from "./ScopeSegmented";
export { TablePagination } from "./TablePagination";
export { ThLabel } from "./ThLabel";
export { Toast } from "./Toast";
export { useToast } from "./useToast";
export { prazoRelativo, estadoCaso, estadoEtapa, TOM_ESTADO_CASO, TOM_ESTADO_ETAPA } from "./estados";
export {
  EstadoCasoBadge,
  EstadoEtapaBadge,
  PainelPrazos,
  StepperEtapas,
  TimelineCaso,
  type EtapaStepper,
  type EventoTimeline,
  type PrazoLegal,
} from "./rh";
