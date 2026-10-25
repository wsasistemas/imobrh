import { useEffect, useRef } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { PageSkeleton } from "../../../components/PageSkeleton";
import { ErrorState } from "../../configuracoes/components/ErrorState";
import { ServiceError } from "../../configuracoes/services/types";
import { useCriarSolicitacao, useMinhasSolicitacoes } from "../hooks";
import type { TipoSolicitacao } from "../solicitacoes";
import { CartoesInicio } from "./MinhasSolicitacoes";

/** "Nova solicitação" do menu: os cartões de início. */
export function NovaSolicitacao() {
  const q = useMinhasSolicitacoes();
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState message="Não foi possível carregar." onRetry={() => void q.refetch()} />;
  return <CartoesInicio temFundoFixo={q.data.temFundoFixo} temSetor={q.data.temSetor} />;
}

const ROTA: Record<string, TipoSolicitacao> = { reembolso: "reembolso", "fundo-fixo": "fundo_fixo", adiantamento: "adiantamento" };

/** /financeiro/solicitacoes/nova/reembolso, …/fundo-fixo e …/adiantamento (rotas do PRD): cria o rascunho e abre o formulário. */
export function CriarSolicitacao() {
  const { tipo = "" } = useParams();
  const criar = useCriarSolicitacao();
  const navegar = useNavigate();
  const feito = useRef(false);
  const t = ROTA[tipo];
  useEffect(() => {
    if (!t || feito.current) return;
    feito.current = true;
    criar.mutate(t, {
      onSuccess: (id) => navegar(`/financeiro/solicitacoes/${id}`, { replace: true }),
      onError: (e) => {
        toast.error(e instanceof ServiceError ? e.message : "Não foi possível criar a solicitação.");
        navegar("/financeiro/nova", { replace: true });
      },
    });
  }, [t, criar, navegar]);
  if (!t) return <Navigate to="/financeiro/nova" replace />;
  return <PageSkeleton />;
}
