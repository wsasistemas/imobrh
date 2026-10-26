/** JSON devolvido pelas RPCs do app_imobrh (as funções devolvem jsonb). */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
