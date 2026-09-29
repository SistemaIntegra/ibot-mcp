/**
 * Cliente HTTP da API interna do painel I-Bot.
 *
 * O painel é uma SPA que consome endpoints JSON autenticados apenas pelo cookie
 * de sessão — o mesmo que o Playwright já usa via session.json. Chamar esses
 * endpoints direto dispensa abrir o browser: leitura de chats/mensagens sai em
 * ~250ms em vez de dezenas de segundos, e o dado vem do servidor (não da UI,
 * que às vezes está desatualizada).
 *
 * Não é API documentada: pode mudar sem aviso. Por isso as tools do index.js
 * caem no caminho Playwright quando algo aqui quebra (ver PanelError).
 *
 * Login continua sendo feito uma vez pelo browser (login.js), que gera o cookie.
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import os from "os";

/**
 * Sessão do painel (cookies salvos pelo login). Fica FORA da pasta do pacote de
 * propósito: com npx a pasta muda a cada versão e a sessão sumiria junto.
 * Sobrescreva com IBOT_SESSION_PATH.
 */
export const SESSION_PATH = process.env.IBOT_SESSION_PATH || join(os.homedir(), ".ibot-mcp", "session.json");

/** Domínio do painel. O padrão é o do I-Bot; conta white-label usa o próprio (IBOT_DOMAIN=minhaempresa.app). */
export const PANEL_DOMAIN = process.env.IBOT_DOMAIN || "ibotzap.com.br";

export const LOGIN_CMD = "ibot-mcp login";

/** Mensagens por página do /messages2 (a paginação é cumulativa: page/N = ~20*N msgs). */
const MSGS_PER_PAGE = 20;

/** Erro recuperável: o painel respondeu algo inesperado → chamador cai no Playwright. */
export class PanelError extends Error {}

/**
 * Entrada inválida do chamador (aparelho que não existe, status fora da lista).
 * NÃO pode cair no Playwright: o caminho do navegador ignora aparelho
 * desconhecido em silêncio e devolveria conversa do aparelho errado. Erro de
 * digitação tem que estourar, não virar resultado plausível.
 */
export class InputError extends PanelError {}

/** Erro terminal: cookie ausente ou expirado → Playwright também vai falhar. */
export class SessionError extends Error {}

// ─── SESSÃO ──────────────────────────────────────────────────────────────────

let cookieCache = null;

async function getCookie() {
  if (cookieCache) return cookieCache;
  if (!existsSync(SESSION_PATH)) {
    throw new SessionError(`Sessão não encontrada. Execute \`IBOT_SERVER=${process.env.IBOT_SERVER || "N"} ${LOGIN_CMD}\` para fazer login.`);
  }
  const state = JSON.parse(await readFile(SESSION_PATH, "utf-8"));
  const cookie = (state.cookies || [])
    .filter((c) => c.domain.includes(PANEL_DOMAIN))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  if (!cookie) throw new SessionError(`A sessão salva não tem cookies de ${PANEL_DOMAIN}. Rode \`${LOGIN_CMD}\` de novo.`);
  cookieCache = cookie;
  return cookie;
}

/** Invalida o cookie em memória (usado quando a sessão expira). */
export function resetSession() {
  cookieCache = null;
}

// ─── TRANSPORTE ──────────────────────────────────────────────────────────────

export function baseUrl(server) {
  return `https://s${server}.${PANEL_DOMAIN}`;
}

/**
 * Requisição ao painel. `json` vira body JSON, `form` vira x-www-form-urlencoded.
 * Detecta sessão expirada (redirect pro login) e converte em SessionError.
 */
async function request(server, method, path, { json, form } = {}) {
  const cookie = await getCookie();
  const headers = {
    cookie,
    "x-requested-with": "XMLHttpRequest",
    accept: "application/json, text/javascript, */*; q=0.01",
  };
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }

  let res;
  try {
    res = await fetch(baseUrl(server) + path, { method, headers, body, redirect: "manual" });
  } catch (err) {
    throw new PanelError(`Falha de rede no painel (${path}): ${err.message}`);
  }

  // 3xx pro login, ou 401/403 = cookie morto
  const location = res.headers.get("location") || "";
  if ((res.status >= 300 && res.status < 400 && /login|signin/i.test(location)) || res.status === 401 || res.status === 403) {
    resetSession();
    throw new SessionError(`Sessão expirada. Execute \`IBOT_SERVER=${server} ${LOGIN_CMD}\` para renovar.`);
  }
  if (!res.ok) throw new PanelError(`Painel respondeu HTTP ${res.status} em ${path}.`);

  const text = await res.text();
  if (/<form[^>]+login|name=["']password["']/i.test(text.slice(0, 4000))) {
    resetSession();
    throw new SessionError(`Sessão expirada. Execute \`IBOT_SERVER=${server} ${LOGIN_CMD}\` para renovar.`);
  }
  return text;
}

async function requestJson(server, method, path, opts) {
  const text = await request(server, method, path, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new PanelError(`Painel não devolveu JSON em ${path} (recebi ${text.length} bytes).`);
  }
}

// ─── TELEFONE ────────────────────────────────────────────────────────────────

/**
 * Gera variantes de busca para um número. O I-Bot guarda números em formatos
 * variados (com/sem DDI, com/sem nono dígito), então tentamos vários.
 */
export function phoneSearchVariants(input) {
  const digits = String(input).replace(/\D/g, "");
  const variants = new Set([digits]);
  if (digits.startsWith("55") && digits.length >= 12) variants.add(digits.substring(2));
  if (digits.startsWith("549") && digits.length >= 12) variants.add(digits.substring(3));
  if (digits.startsWith("507") && digits.length >= 11) variants.add(digits.substring(3));
  if (digits.length >= 9) variants.add(digits.slice(-9));
  if (digits.length >= 8) variants.add(digits.slice(-8));
  return [...variants].filter(Boolean);
}

// ─── APARELHOS (DEVICES) ─────────────────────────────────────────────────────

/**
 * O mesmo número pode existir em MAIS DE UM aparelho, com conversas
 * diferentes. Sem filtrar por aparelho a busca devolve o primeiro match, que
 * pode ser o histórico errado — por isso as tools filtram por padrão.
 */

let phonesCache = null;

/** Lista os aparelhos da conta: [{ id, description, owner_wa_id }]. */
export async function listPhones(server) {
  if (!phonesCache) phonesCache = await requestJson(server, "GET", "/chatlist/phones");
  return phonesCache;
}

/**
 * Resolve o nome de um aparelho pro id que o filtro espera.
 * Aceita o id direto, ou parte do nome (case-insensitive, igual ao dropdown).
 * String vazia = não filtrar (busca em todos os aparelhos).
 */
export async function resolvePhoneId(server, device) {
  if (!device) return "";
  const phones = await listPhones(server);
  const wanted = String(device).trim().toLowerCase();
  const match = phones.find((p) => p.id === device)
    || phones.find((p) => (p.description || "").toLowerCase() === wanted)
    || phones.find((p) => (p.description || "").toLowerCase().includes(wanted));
  if (!match) {
    throw new InputError(
      `Aparelho "${device}" não existe nesta conta. Disponíveis: ${phones.map((p) => p.description).join(", ")}. ` +
      `Use string vazia para buscar em todos.`
    );
  }
  return match.id;
}

// ─── RESPONSÁVEIS (USUÁRIO / DEPARTAMENTO) ───────────────────────────────────

/**
 * O dropdown "Usuário/Departamento" do painel. Pessoa e departamento saem do
 * MESMO endpoint e vão pro MESMO filtro, em listas separadas de ids — por isso
 * aqui um termo só resolve nos dois e o chamador não precisa saber qual é qual.
 */

let ownersCache = null;

/** Responsáveis da conta: { users: [{id,type,name,email}], groups: [{id,name}] }.
 *  `groups` são os DEPARTAMENTOS (Vendas, Suporte, Financeiro…). */
export async function listOwners(server) {
  if (!ownersCache) ownersCache = await requestJson(server, "GET", "/chatlist/users_and_groups");
  return ownersCache;
}

/** Termos que significam "chat sem ninguém responsável" (o "Sem usuário delegado" do painel).
 *  Sem acento de propósito: a comparação normaliza os dois lados antes de bater. */
const NO_OWNER = ["sem responsavel", "sem usuario delegado", "sem dono", "nao delegado", "sem delegado"];

const semAcento = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

/**
 * Resolve nomes de pessoas/departamentos pro formato que o filtro espera.
 *
 * O filtro do painel é por ID, e pessoa e departamento moram no MESMO dropdown —
 * por isso um termo só resolve nos dois. Devolve null quando nada foi pedido,
 * pra manter o payload padrão.
 */
export async function resolveOwners(server, responsavel, catalogoInjetado) {
  const termos = (Array.isArray(responsavel) ? responsavel : [responsavel])
    .map((t) => String(t ?? "").trim()).filter(Boolean);
  if (!termos.length) return null;

  // catalogoInjetado existe pro teste rodar offline; em produção vem do painel.
  const { users = [], groups = [] } = catalogoInjetado || await listOwners(server);
  const catalogo = () =>
    `Pessoas: ${users.map((u) => u.name).join(", ")}. ` +
    `Departamentos: ${groups.map((g) => g.name).join(", ")}. ` +
    `Use "sem responsável" para os chats sem ninguém delegado.`;

  const out = { users: [], groups: [], noDelegated: false };
  for (const termo of termos) {
    const alvo = semAcento(termo);
    if (NO_OWNER.includes(alvo)) { out.noDelegated = true; continue; }

    const candidatos = [
      ...users.filter((u) => u.id === termo || semAcento(u.name) === alvo || semAcento(u.email || "") === alvo).map((u) => ["users", u]),
      ...groups.filter((g) => g.id === termo || semAcento(g.name) === alvo).map((g) => ["groups", g]),
    ];
    // Só cai pro parcial se o exato não achou nada — senão "Vendas" pegaria "Vendas Geral" junto.
    const parciais = candidatos.length ? candidatos : [
      ...users.filter((u) => semAcento(u.name).includes(alvo)).map((u) => ["users", u]),
      ...groups.filter((g) => semAcento(g.name).includes(alvo)).map((g) => ["groups", g]),
    ];

    if (!parciais.length) {
      throw new InputError(`Responsável "${termo}" não existe nesta conta. ${catalogo()}`);
    }
    if (parciais.length > 1) {
      // Ambiguidade tem que estourar: escolher um dos dois calado devolveria a
      // lista de OUTRA pessoa com cara de filtro certo.
      throw new InputError(
        `Responsável "${termo}" é ambíguo — casa com ${parciais.length}: ${parciais.map(([, x]) => `"${x.name}"`).join(", ")}. ` +
        `Escreva o nome completo ou passe o id.`
      );
    }
    const [tipo, achado] = parciais[0];
    if (!out[tipo].includes(achado.id)) out[tipo].push(achado.id);
  }
  return out;
}

// ─── LEITURA: CHATS ──────────────────────────────────────────────────────────

/**
 * Valor que o backend aceita como "filtro ligado".
 *
 * É comparação literal de string, estilo Python: "True" liga, "true" e true
 * são IGNORADOS EM SILÊNCIO — a lista volta completa como se nenhum filtro
 * tivesse sido pedido. Erra sem erro, então nunca troque por booleano.
 */
export const FILTER_ON = "True";

/** Payload padrão do /chatlist/store — todos os campos são obrigatórios pro backend. */
export function chatFilters(overrides = {}) {
  return {
    page_num: 0,
    filter_order_by: "",
    filter_tag: [],
    filter_tag_rule: "or",
    filter_user_rule: "or",
    filter_user: { users: [], groups: [], noDelegated: false },
    filter_phone: "",
    filter_funnel_step: [],
    filter_status: "",
    filter_search_number: "",
    filter_search_name: "",
    filter_new_messages: "",
    filter_archived: "",
    filter_broadcast: "",
    filter_favorited: "",
    filter_scheduled: "",
    ...overrides,
  };
}

/** Normaliza um chat cru do painel pro formato que as tools expõem. */
export function normalizeChat(c) {
  return {
    chat_id: c.id,
    contact_name: c.name || "",
    wa_chat_id: c.wa_chat_id || "",
    kind: c.kind || "",
    phone_id: c.phone_id || "", // aparelho dono da conversa (ver listPhones)
    status: c.status || "INDEFINIDO",
    unread_count: c.new_messages || 0,
    last_message: c.last_message?.text || "",
    timestamp: c.last_message?.date || c.updated || "",
    archived: !!c.archived,
    favorite: !!c.favorite,
    tags: (c.tags || []).map((t) => t?.text ?? t),
    users_delegated_ids: c.users_delegated_ids || [],
    groups_delegated_ids: c.groups_delegated_ids || [],
  };
}

/**
 * Lista chats com os mesmos filtros da UI. Pagina sozinho até atingir `limit`
 * (o painel devolve 100 por página).
 *
 * `archived` é EXCLUSIVO, igual ao checkbox do painel: ligado, devolve SÓ os
 * arquivados; desligado, SÓ os não arquivados. Não existe "os dois juntos" —
 * quem precisa de cobertura total faz as duas chamadas (ver findChatByPhone).
 */
export async function listChats(server, { status, name, whatsapp_number, unread_only, archived, favorited, order_by, device, responsavel, limit = 50 } = {}) {
  const phoneId = await resolvePhoneId(server, device);
  const owners = await resolveOwners(server, responsavel);
  const out = [];
  for (let page = 0; out.length < limit; page++) {
    const data = await requestJson(server, "POST", "/chatlist/store", {
      json: chatFilters({
        page_num: page,
        filter_phone: phoneId,
        ...(owners ? { filter_user: owners } : {}),
        filter_status: status || "",
        filter_search_name: name || "",
        filter_search_number: whatsapp_number ? String(whatsapp_number).replace(/\D/g, "") : "",
        filter_new_messages: unread_only ? FILTER_ON : "",
        filter_archived: archived ? FILTER_ON : "",
        filter_favorited: favorited ? FILTER_ON : "",
        filter_order_by: order_by || "",
      }),
    });
    const chats = data.chats;
    if (!Array.isArray(chats)) throw new PanelError("/chatlist/store não devolveu a lista de chats.");
    out.push(...chats.map(normalizeChat));
    if (chats.length === 0 || out.length >= (data.total_chats ?? 0)) break;
  }
  return out.slice(0, limit);
}

/**
 * Busca um chat por telefone, tentando as variantes de formato.
 *
 * Varre em dois passes porque o filtro de arquivados é exclusivo: primeiro os
 * chats ativos, depois (se `archived`) os arquivados. Sem o segundo pass um
 * contato encerrado simplesmente não existe — numa conta madura a maioria dos
 * chats está arquivada.
 */
export async function findChatByPhone(server, phone, { archived = true, device } = {}) {
  const variants = phoneSearchVariants(phone);
  for (const onlyArchived of archived ? [false, true] : [false]) {
    for (const variant of variants) {
      const chats = await listChats(server, { whatsapp_number: variant, archived: onlyArchived, device, limit: 1 });
      if (chats.length) return { ...chats[0], matched_variant: variant };
    }
  }
  return null;
}

// ─── LEITURA: MENSAGENS ──────────────────────────────────────────────────────

/**
 * Achata o array messages_and_notes (Mongo extended JSON) no formato das tools.
 * Mensagens e anotações vêm misturadas e em ordem cronológica.
 */
export function normalizeMessages(items) {
  return (items || []).map((item) => {
    const when = item.date?.$date || item.m?.timestamp?.$date || null;
    if (item.type === "note") {
      return { tipo: "anotacao", remetente: item.n?.author || "", quando: when, texto: item.n?.text || "" };
    }
    const m = item.m || {};
    const out = {
      tipo: "mensagem",
      remetente: m.is_out ? "atendente" : "cliente",
      quando: when,
      texto: m.text || (m.type && m.type !== "chat" ? `[${m.type}]` : ""),
      status: m.status || "",
      wa_message_id: m.wa_message_id || "",
    };
    // Mídia: m.file traz o arquivo no S3 do painel (baixável — ver ibot_download_media).
    if (m.file?.name && /^https?:/.test(m.file.path_relative || "")) {
      out.arquivo = {
        nome: m.file.name,
        mime: m.file.mime || "",
        tamanho: m.file.size || 0,
        url: `${m.file.path_relative}/${m.file.name}`,
      };
    }
    return out;
  });
}

/**
 * Lê mensagens + anotações de um chat.
 *
 * A paginação do painel é CUMULATIVA: page/N devolve as ~20*N mensagens mais
 * recentes de uma vez e satura ao chegar no início da conversa. Ou seja, o
 * histórico inteiro sai num request só — mas o payload cresce linear (um chat
 * de 4k mensagens dá ~5MB), então pedimos só a página que cobre o `limit`.
 */
export async function readMessages(server, chat_id, limit = 50) {
  const page = Math.max(1, Math.ceil(limit / MSGS_PER_PAGE));
  const data = await requestJson(server, "GET", `/messages2/${chat_id}/page/${page}`);
  if (!Array.isArray(data.messages_and_notes)) throw new PanelError("/messages2 não devolveu messages_and_notes.");
  const all = normalizeMessages(data.messages_and_notes);
  return {
    chat_status: data.cst || "",
    total_enviadas: data.count_msg_sent ?? null,
    // cumulativo → as mais recentes estão no fim
    mensagens: all.slice(-limit),
    truncado: all.length > limit || data.messages_and_notes.length >= page * MSGS_PER_PAGE,
  };
}

// ─── LEITURA: CAMPOS PERSONALIZADOS E TAGS ───────────────────────────────────

/**
 * Esses dois endpoints devolvem fragmento HTML (não JSON) — é o front montando
 * o painel lateral. Os valores estão nos atributos, então o parse é direto.
 */

export function parseCustomFields(html) {
  const fields = [];
  // cada linha da tabela: <td>Rótulo:</td> ... <input|textarea data-cf-id="..." value="...">
  const rows = html.split(/<tr[\s>]/i).slice(1);
  for (const row of rows) {
    const label = row.match(/<td[^>]*>\s*([^<]+?)\s*:?\s*<\/td>/i)?.[1]?.trim();
    if (!label) continue;
    const id = row.match(/data-cf-id="([^"]*)"/i)?.[1] || "";
    let value = "";
    const input = row.match(/<input[^>]*data-cf-id="[^"]*"[^>]*>/i)?.[0];
    if (input) {
      value = decodeHtml(input.match(/value="([^"]*)"/i)?.[1] || "");
    } else {
      const textarea = row.match(/<textarea[^>]*data-cf-id="[^"]*"[^>]*>([\s\S]*?)<\/textarea>/i);
      if (textarea) value = decodeHtml(textarea[1].trim());
      else {
        const selected = row.match(/<option[^>]*selected[^>]*>([\s\S]*?)<\/option>/i);
        if (selected) value = decodeHtml(selected[1].trim());
      }
    }
    fields.push({ campo: label, valor: value, cf_id: id });
  }
  return fields;
}

/**
 * O fragmento traz DUAS listas: o dropdown com todas as tags da conta
 * (`add_chat_tag`) e as tags realmente aplicadas ao chat, cada uma com um botão
 * de remover (`delete_chat_tag` + data-tag-text). Só as aplicadas interessam.
 */
export function parseTags(html) {
  const tags = new Set();
  for (const m of html.matchAll(/delete_chat_tag[^>]*data-tag-text="([^"]*)"/gi)) tags.add(decodeHtml(m[1]));
  return [...tags].filter(Boolean);
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export async function readCustomFields(server, chat_id) {
  return parseCustomFields(await request(server, "POST", `/chat/custom_fields/${chat_id}/view`));
}

export async function readTags(server, chat_id) {
  return parseTags(await request(server, "POST", `/chat_tags/${chat_id}`));
}

// Este módulo é SÓ LEITURA de propósito. Existiu aqui um `setStatus` sobre
// POST /chat/{id}/set_status, removido antes do merge: o endpoint não valida
// nada (mandar "XPTO" grava "XPTO" e o status fantasma entra nos filtros), e
// escrita em produção por API não-documentada não paga o risco de existir só
// porque é fácil. Se voltar um dia, volta com whitelist no cliente.
