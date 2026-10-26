import type { VinculosService } from "../contracts";
import { ServiceError } from "../types";
import { db } from "./db";
import { delay, findUser, recordAudit, requirePermission } from "./runtime";

// CPFs que o "RM" do modo simulado conhece (os mesmos de FUNCIONARIOS_MOCK em supabase/functions/_shared/rm/nucleo.ts).
const RM_MOCK: Record<string, { chapa: string; nome: string; desligado?: boolean }> = {
  "52998224725": { chapa: "000101", nome: "Ana Paula Ribeiro" },
  "11144477735": { chapa: "000102", nome: "Bruno Carvalho" },
  "39053344705": { chapa: "000201", nome: "Carla Mendes" },
  "71428793860": { chapa: "000202", nome: "Diego Souza" },
  "86288366757": { chapa: "000001", nome: "Eduardo Lima" },
};

/** Divergentes primeiro (o DP precisa agir no RM), depois CPF não encontrado, depois nunca vinculados. */
const ORDEM = { divergente: 0, pendente: 1, sem_registro: 2 } as const;

function mask(cpf: string): string {
  return `***.${cpf.slice(3, 6)}.***-${cpf.slice(9, 11)}`;
}

function cpfValid(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (end: number) => {
    let sum = 0;
    for (let i = 0; i < end; i++) sum += Number(cpf[i]) * (end + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
}

export const mockVinculosService: VinculosService = {
  async listPending() {
    await delay();
    requirePermission("config_vinculos");
    return db.users
      .filter((record) => record.status !== "inactive" && record.linkStatus !== "vinculado")
      .map((record) => ({
        userId: record.id,
        name: record.name,
        email: record.email,
        status: record.linkStatus as "sem_registro" | "pendente" | "divergente",
        reason: record.linkReason,
        cpfMasked: record.cpf ? mask(record.cpf) : null,
        updatedAt: record.linkUpdatedAt,
      }))
      .sort((a, b) => ORDEM[a.status] - ORDEM[b.status] || a.name.localeCompare(b.name, "pt-BR"));
  },

  async link(userId, cpf) {
    await delay();
    requirePermission("config_vinculos");
    const digits = cpf.replace(/\D/g, "");
    if (!cpfValid(digits)) throw new ServiceError("VALIDACAO", "Informe os 11 dígitos de um CPF válido.", "cpf");
    const target = findUser(userId);
    const other = db.users.find((record) => record.cpf === digits && record.linkStatus === "vinculado" && record.id !== userId);
    if (other) throw new ServiceError("ESTADO_INVALIDO", `A chapa deste CPF já está vinculada a ${other.name}.`, "cpf");

    const found = RM_MOCK[digits];
    target.cpf = digits;
    target.linkUpdatedAt = new Date().toISOString();
    if (!found) {
      target.linkStatus = "pendente";
      target.linkReason = "CPF não encontrado no TOTVS RM.";
    } else if (found.desligado) {
      target.linkStatus = "divergente";
      target.linkReason = "Funcionário desligado no TOTVS RM.";
    } else {
      target.linkStatus = "vinculado";
      target.chapa = found.chapa;
      target.linkReason = null;
      if (!target.roles.includes("colaborador")) {
        target.roles = [...target.roles, "colaborador"];
        target.rmRoles = [...target.rmRoles, "colaborador"];
      }
    }
    recordAudit({
      module: "vinculos",
      action: "update",
      description: `Vínculo de ${target.name} com o RM: ${target.linkStatus === "vinculado" ? `chapa ${target.chapa}` : target.linkStatus}`,
      targetKey: "colaborador_vinculo",
    });
    return {
      status: target.linkStatus as "vinculado" | "pendente" | "divergente",
      chapa: target.chapa,
      name: found?.nome ?? null,
      reason: target.linkReason,
    };
  },
};
