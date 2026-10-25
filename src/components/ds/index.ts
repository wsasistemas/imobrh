// Design system do dashboard. Estilos sob .ds; cores só por tokens --ds-* (src/index.css).
import "./ds.css";
import "./components.css";

export { AlertBanner } from "./AlertBanner";
export { DetailBody, DetailDialog } from "./DetailDialog";
export { FilterSelect, type FilterOption } from "./FilterSelect";
export { InboundChart, type InboundPoint } from "./InboundChart";
export { KpiCard, type KpiVariant } from "./KpiCard";
export { NewTicketDialog, type NewTicketInput, type TicketService } from "./NewTicketDialog";
export { PageHeading } from "./PageHeading";
export { Panel, PanelHeader } from "./Panel";
export { Pill, type PillTone } from "./Pill";
export { QueueTable, type QueueTableRow } from "./QueueTable";
export { ScopeSegmented, type SegmentOption } from "./ScopeSegmented";
export { SlaHealth, type SlaMetric } from "./SlaHealth";
export { formatDuration, slaLabel, slaTone, SLA_SOON_MINUTES } from "./sla";
export { TablePagination } from "./TablePagination";
export { ThLabel } from "./ThLabel";
export { TeamDistribution, type TeamLoad } from "./TeamDistribution";
export { Toast } from "./Toast";
export { TriagePanel, type TriageBar } from "./TriagePanel";
export { useToast } from "./useToast";
