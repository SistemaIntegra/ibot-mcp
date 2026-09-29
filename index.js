#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import os from "os";
import * as panel from "./panel.js";
import { phoneSearchVariants, SessionError, InputError, SESSION_PATH, LOGIN_CMD } from "./panel.js";

const require = createRequire(import.meta.url);
const { version } = require("./package.json");

// ─── SUBCOMANDOS ─────────────────────────────────────────────────────────────
// `ibot-mcp login` abre o navegador pra salvar a sessão do painel; `--version` imprime a versão.
if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  console.log(version);
  process.exit(0);
}
if (process.argv[2] === "login") {
  await import("./login.js"); // encerra o processo sozinho ao terminar
}

// ─── CONFIGURAÇÃO ────────────────────────────────────────────────────────────
// Este servidor é SOMENTE LEITURA: não envia mensagem, não altera contato, não dispara fluxo.

const API_KEY = process.env.IBOT_API_KEY;
const ACCOUNT_ID = process.env.IBOT_ACCOUNT_ID;
// A conta I-Bot tem mais de um número conectado. Cada número tem o próprio Phone ID.
const PHONE_IDS = [process.env.IBOT_PHONE_ID, process.env.IBOT_PHONE_ID_2].filter(Boolean);
const PHONE_ID = PHONE_IDS[0];
const SERVER = process.env.IBOT_SERVER || "16";
const BASE_URL = `${panel.baseUrl(SERVER)}/api/v1`;
// Aparelho padrão das tools de leitura ("" = todos os números).
const DEFAULT_DEVICE = process.env.IBOT_DEVICE || "";
const HAS_API = Boolean(API_KEY && ACCOUNT_ID && PHONE_ID);

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const RETRYABLE_STATUSES = [408, 429, 500, 502, 503, 504];

function friendlyError(status, defaultMsg) {
  const messages = {
    401: "Chave de API inválida. Verifique a variável IBOT_API_KEY.",
    403: "Sem permissão para acessar este recurso no I-Bot.",
    404: "Recurso não encontrado no I-Bot.",
    429: "Limite de requisições atingido. Tente novamente em alguns segundos.",
    500: "Erro interno do servidor I-Bot. Tente novamente.",
    502: "I-Bot temporariamente indisponível. Tente novamente.",
    503: "I-Bot em manutenção. Tente novamente em instantes.",
  };
  return messages[status] || defaultMsg || `Erro ${status} na API do I-Bot.`;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normaliza número de telefone para formato DDI+DDD+NÚMERO (somente dígitos).
 * Aceita: +55 (11) 99999-0000, 55 11 99999-0000, 11999990000, 5511999990000
 */
function normalizePhone(input) {
  // Remove tudo que não é dígito
  let digits = input.replace(/\D/g, "");

  // Se começa com 55 e tem 12-13 dígitos, já está normalizado
  if (digits.startsWith("55") && digits.length >= 12) {
    return digits;
  }

  // Se tem 10-11 dígitos (DDD + número), adiciona DDI 55
  if (digits.length >= 10 && digits.length <= 11) {
    return "55" + digits;
  }

  // Retorna como está (pode ser número internacional não-BR)
  return digits;
}

/**
 * Faz requisição à API do I-Bot com retry automático.
 * Body é form-encoded (application/x-www-form-urlencoded), NÃO JSON.
 */
async function ibotRequest(action, params = {}, { retries = 3, paramsInUrl = false, phoneId } = {}) {
  const urlParams = new URLSearchParams({
    key: API_KEY,
    account_id: ACCOUNT_ID,
    phone_id: phoneId || PHONE_ID,
    action: action,
  });

  let body = "";
  if (paramsInUrl) {
    // Enviar todos os params na query string (ex: chat_update_custom_fields)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) urlParams.append(key, String(value));
    }
  } else {
    // Enviar params no body (padrão para a maioria dos endpoints)
    const bodyParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) bodyParams.append(key, String(value));
    }
    body = bodyParams.toString();
  }

  const url = `${BASE_URL}?${urlParams.toString()}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (err) {
      if (attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        console.error(`[I-Bot] Erro de rede (tentativa ${attempt}/${retries}): ${err.message}. Retry em ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      throw new Error(`Erro de conexão com I-Bot após ${retries} tentativas: ${err.message}`);
    }

    if (!response.ok && RETRYABLE_STATUSES.includes(response.status) && attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      console.error(`[I-Bot] HTTP ${response.status} (tentativa ${attempt}/${retries}). Retry em ${delay}ms...`);
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      throw new Error(friendlyError(response.status));
    }

    const data = await response.json();
    if (data.success === false) {
      throw new Error(data.error || data.message || "Erro desconhecido na API do I-Bot.");
    }
    return data;
  }
}


// ─── MCP SERVER ──────────────────────────────────────────────────────────────

const INSTRUCOES = [
  "I-Bot MCP (Integra Sistema): leitura do WhatsApp da conta I-Bot do usuário. SOMENTE LEITURA — não existe tool de envio ou edição.",
  "A conta I-Bot tem DOIS números de WhatsApp conectados. Ao listar ou ler conversas, deixe claro de qual número/aparelho cada chat é; " +
    "para não misturar, use o parâmetro de aparelho quando o usuário falar de um número específico. " +
    `Phone IDs configurados: ${PHONE_IDS.length} (${PHONE_IDS.length < 2 ? "ATENÇÃO: falta configurar o segundo número (IBOT_PHONE_ID_2)" : "os dois números"}).`,
  "As tools de leitura usam a sessão do painel salva por `ibot-mcp login`; se responderem 'Sessão expirada', peça ao usuário para rodar o login de novo — nunca peça senha no chat.",
  "Toda tool de listagem diz no rodapé qual corte ocorreu (fim da lista / teto do painel / limite pedido): leia antes de concluir que algo 'não existe'.",
].join("\n");

const server = new McpServer({ name: "ibot-mcp", version }, { instructions: INSTRUCOES });

// ─── TOOLS DA API OFICIAL (só consulta; exigem IBOT_API_KEY / ACCOUNT_ID / PHONE_ID) ──

if (HAS_API) {

const phoneIdParam = z.string().optional().describe(
  `Phone ID do número a consultar. Padrão: o primeiro número. Configurados: ${PHONE_IDS.join(", ")}`
);

server.tool(
  "ibot_get_message_status",
  "Consulta o status de entrega de uma mensagem enviada pelo I-Bot.",
  {
    message_id: z.string().describe("ID da mensagem"),
    phone_id: phoneIdParam,
  },
  async ({ message_id, phone_id }) => {
    const data = await ibotRequest("message_status", { message_id }, { phoneId: phone_id });
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "ibot_get_chat_status",
  "Verifica o status do registro de um chat no I-Bot. Retorna: pending, fetched, done ou error. Quando done, inclui link do chat.",
  {
    chat_add_id: z.string().describe("ID do chat (ex: 699ce2eab27ac598c766e752), obtido por ibot_get_chat_link"),
    phone_id: phoneIdParam,
  },
  async ({ chat_add_id, phone_id }) => {
    const data = await ibotRequest("chat_add_status", { chat_add_id }, { phoneId: phone_id });
    let msg = `Status: ${data.chat_add_status || "desconhecido"}`;
    msg += `\nchat_add_id: ${chat_add_id}`;
    msg += `\nLink: ${panel.baseUrl(SERVER)}/chats#${chat_add_id}`;
    if (data.chat_add_status_description) msg += `\nDescrição: ${data.chat_add_status_description}`;
    return { content: [{ type: "text", text: msg }] };
  }
);

} // fim do bloco HAS_API

// ─── TOOLS PLAYWRIGHT (disponíveis em todos os modos) ───────────────────────

// ─── HELPER: ABRIR BROWSER COM SESSÃO ────────────────────────────────────────

async function openBrowserWithSession() {
  if (!existsSync(SESSION_PATH)) {
    return { error: `Sessão não encontrada. Execute \`ibot-mcp login\` para fazer login.` };
  }
  const storageState = JSON.parse(await readFile(SESSION_PATH, "utf-8"));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState, permissions: ["notifications"] });
  // ponytail: remove qualquer banner/overlay que intercepte cliques (ex.: banner
  // "sem crédito" / incidente de reconexão do I-Bot). Roda em toda navegação.
  await context.addInitScript(() => {
    const KILL = [
      "#reconnection_banner_app",
      ".reconnection-incident-backdrop",
    ];
    const nuke = () => {
      for (const sel of KILL) {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      }
      document.documentElement.style.overflow = "";
      if (document.body) {
        document.body.style.overflow = "";
        document.body.style.pointerEvents = "";
      }
    };
    const start = () => {
      nuke();
      try {
        new MutationObserver(nuke).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      } catch (e) {}
      setInterval(nuke, 500);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  });
  const page = await context.newPage();
  return { browser, context, page };
}

function isLoginPage(url) {
  return url.includes("login") || url.includes("signin") || url.endsWith("/");
}

function text(t) {
  return { content: [{ type: "text", text: t }] };
}

/**
 * Tenta a leitura pela API interna do painel (~250ms, sem browser).
 *
 * Retorna { ok } em caso de sucesso, { fatal } quando a sessão expirou (o
 * Playwright usa o mesmo cookie, então não adianta cair pra ele), e null quando
 * o painel falhou de forma recuperável — aí o chamador segue pro Playwright,
 * que continua sendo o fallback caso a API não-documentada mude.
 */
async function viaPainel(fn) {
  // Sem isto o caminho de fallback só roda quando a API não-documentada quebra em
  // produção — ou seja, nunca é testado antes de ser necessário.
  if (process.env.IBOT_FORCE_PLAYWRIGHT === "true") return null;
  try {
    return { ok: await fn() };
  } catch (err) {
    // entrada inválida e sessão morta não têm fallback: o Playwright ou
    // repetiria o mesmo erro, ou (pior) aceitaria a entrada errada calado.
    if (err instanceof SessionError || err instanceof InputError) return { fatal: err.message };
    console.error(`[I-Bot] painel indisponível (${err.message}) — usando Playwright.`);
    return null;
  }
}

/** Formata o resultado do batch de busca (mesmo layout nos dois caminhos). */
function formatBatch(results) {
  const found = results.filter(r => r.status === "ENCONTRADO");
  const notFound = results.filter(r => r.status === "NAO_ENCONTRADO");

  let summary = `Processados: ${results.length} | Encontrados: ${found.length} | Não encontrados: ${notFound.length}\n\n`;

  if (found.length > 0) {
    summary += "ENCONTRADOS:\n";
    for (const r of found) {
      summary += `  ${r.name || r.id} -> ${r.link} (formato: ${r.matched_variant})\n`;
    }
  }

  if (notFound.length > 0) {
    summary += "\nNÃO ENCONTRADOS:\n";
    for (const r of notFound) {
      summary += `  ${r.name || r.id} (${r.phone})\n`;
    }
  }

  return summary + "\n\nJSON:\n" + JSON.stringify(results);
}

/**
 * Seleciona o aparelho (device) no dropdown do painel I-Bot.
 *
 * FALHA RUIDOSA de propósito. A versão antiga pegava o PRIMEIRO `select` da página
 * (que nem sempre é o de aparelho) e voltava calada quando não casava — aí a busca
 * rodava sem filtro e devolvia a conversa de OUTRO aparelho como se fosse a certa.
 * Um typo no nome do aparelho tem que estourar, não virar resultado plausível.
 *
 * @param {import('playwright').Page} page
 * @param {string} deviceName - Nome do aparelho (ex: "Comercial")
 * @throws {Error} se o seletor não existir ou o nome não casar com nenhuma opção
 */
async function selectDevice(page, deviceName) {
  const opcoes = await page.evaluate(() => {
    const sel = document.querySelector("#selChatsDevice");
    if (!sel) return null;
    return [...sel.options].map((o) => ({ value: o.value, label: (o.textContent || "").trim() }));
  });
  if (!opcoes) {
    throw new Error("o seletor de aparelho (#selChatsDevice) não existe nesta página — o painel pode ter mudado. Não filtrei nada e não devolvo resultado, pra não passar busca sem filtro por busca filtrada.");
  }
  const alvo = deviceName.trim().toLowerCase();
  const validas = opcoes.filter((o) => o.value);
  const casada = validas.find((o) => o.value.toLowerCase() === alvo)
    || validas.find((o) => o.label.toLowerCase() === alvo)
    || validas.find((o) => o.label.toLowerCase().includes(alvo));
  if (!casada) {
    throw new Error(`aparelho "${deviceName}" não casou com nenhuma opção do painel. Disponíveis: ${validas.map((o) => `"${o.label}"`).join(" | ")}. Use device:"" para buscar em todos.`);
  }
  await page.selectOption("#selChatsDevice", casada.value);
  await sleep(2000);
  return casada.label;
}

/**
 * Ativa o filtro de chats arquivados (FECHADO/RESOLVIDO).
 * Usa o seletor correto: .list__single__filter.archived input[type='checkbox']
 * @param {import('playwright').Page} page
 */
async function enableArchivedFilter(page) {
  const cb = await page.$(".list__single__filter.archived input[type='checkbox']");
  if (cb) {
    const isChecked = await cb.isChecked();
    if (!isChecked) {
      await cb.click();
      await sleep(2000);
    }
  }
}

// phoneSearchVariants vive em panel.js (usado pelos dois caminhos: painel e Playwright).

/**
 * Busca um chat pelo telefone no painel já aberto, tentando múltiplos formatos.
 * Retorna { chat_id, link } ou null se não encontrado.
 * @param {import('playwright').Page} page
 * @param {string} phoneRaw - Número original do telefone
 */
async function searchChatByPhone(page, phoneRaw) {
  const variants = phoneSearchVariants(phoneRaw);

  for (const variant of variants) {
    const phoneInput = await page.waitForSelector("#inChatsWhatsappNum", { timeout: 10000 });
    await phoneInput.fill("");
    await sleep(300);
    await phoneInput.fill(variant);
    await page.keyboard.press("Enter");
    await sleep(3500);

    const chatItem = await page.$(".list__user-card");
    if (chatItem) {
      await chatItem.click();
      await sleep(2000);

      const currentUrl = page.url();
      const hashMatch = currentUrl.match(/#([a-f0-9]{24})/);
      if (hashMatch) {
        const chatId = hashMatch[1];
        const link = `${panel.baseUrl(SERVER)}/chats#${chatId}`;
        return { chat_id: chatId, link, matched_variant: variant };
      }
    }
  }

  return null;
}

// ─── TOOL 11: BUSCAR CHAT POR TELEFONE (PLAYWRIGHT) ─────────────────────────

server.tool(
  "ibot_get_chat_link",
  "Busca um contato existente no I-Bot pelo número de telefone. Usa a API interna do painel (sem navegador, <1s) e cai no Playwright se ela falhar. Tenta múltiplos formatos de número e cobre chats ativos e arquivados. Aceita filtro por aparelho (padrão: IBOT_DEVICE, ou todos) — o mesmo número pode existir em outro aparelho com conversa diferente. Retorna chat_id e link direto. NÃO envia mensagem. Requer a sessão do painel (rode `ibot-mcp login` primeiro).",
  {
    chat_number: z.string().describe("Número do telefone para buscar (ex: 5511999990000, +55 11 99999-0000, 999990000). Aceita formatos variados — a busca tenta múltiplas variantes automaticamente."),
    device: z.string().optional().default(DEFAULT_DEVICE).describe("Aparelho (número conectado) no I-Bot: nome, parte do nome ou id. Padrão: IBOT_DEVICE; sem ela, busca em todos. O mesmo número pode existir em outro aparelho com conversa diferente — em conta com vários aparelhos, filtre."),
    archived: z.boolean().optional().default(true).describe("Se true, quando não encontrar entre os não arquivados, tenta também os arquivados/fechados (padrão: true)."),
  },
  async ({ chat_number, device, archived }) => {
    const p = await viaPainel(() => panel.findChatByPhone(SERVER, chat_number, { archived, device }));
    if (p?.fatal) return text(p.fatal);
    if (p) {
      const c = p.ok;
      if (c) {
        return text(`Chat encontrado!\nchat_id: ${c.chat_id}\nLink: ${panel.baseUrl(SERVER)}/chats#${c.chat_id}\nNome: ${c.contact_name}\nStatus: ${c.status}\nFormato que encontrou: ${c.matched_variant}`);
      }
      return text(
        `Nenhum chat encontrado para ${chat_number}${device ? ` no aparelho "${device}"` : " em nenhum aparelho"}.\n` +
        `Formatos tentados: ${phoneSearchVariants(chat_number).join(", ")}\n` +
        (device ? `O contato pode existir em OUTRO aparelho — repita com device:"" para buscar em todos.` : `O contato pode não existir no I-Bot.`)
      );
    }

    const session = await openBrowserWithSession();
    if (session.error) return { content: [{ type: "text", text: session.error }] };

    const { browser, page } = session;
    try {
      const panelUrl = `${panel.baseUrl(SERVER)}/chats`;
      await page.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(5000);

      if (isLoginPage(page.url())) {
        await browser.close();
        return { content: [{ type: "text", text: `Sessão expirada. Execute \`ibot-mcp login\` para renovar.` }] };
      }

      // Selecionar aparelho (mantém o filtro do número conectado — evita achar
      // o mesmo número em OUTRO aparelho, que tem conversa diferente)
      if (device) {
        await selectDevice(page, device);
      }

      // Busca em dois estados: primeiro NÃO arquivados (padrão), depois arquivados.
      // O checkbox "arquivados" do I-Bot é EXCLUSIVO (mostra só arquivados),
      // então ligá-lo de cara esconde contatos não arquivados. Cobrimos os dois.
      let result = await searchChatByPhone(page, chat_number);
      if (!result && archived) {
        await enableArchivedFilter(page);
        result = await searchChatByPhone(page, chat_number);
      }
      await browser.close();

      if (result) {
        return { content: [{ type: "text", text: `Chat encontrado!\nchat_id: ${result.chat_id}\nLink: ${result.link}\nFormato que encontrou: ${result.matched_variant}` }] };
      }

      const variants = phoneSearchVariants(chat_number);
      return { content: [{ type: "text", text: `Nenhum chat encontrado para ${chat_number}.\nFormatos tentados: ${variants.join(", ")}\nO contato pode não existir no I-Bot${device ? ` no aparelho "${device}"` : ""}.` }] };
    } catch (err) {
      await browser.close().catch(() => {});
      return { content: [{ type: "text", text: `Erro ao buscar chat: ${err.message}` }] };
    }
  }
);

// ─── TOOL 11B: BUSCAR CHAT EM LOTE (PLAYWRIGHT) ─────────────────────────────

server.tool(
  "ibot_batch_get_chat_links",
  "Busca múltiplos contatos no I-Bot de uma vez. Usa a API interna do painel (sem navegador, ~1s por contato) e cai no Playwright se ela falhar. Aceita filtro por aparelho (padrão: IBOT_DEVICE, ou todos). Retorna lista com chat_id e link para cada contato encontrado.",
  {
    contacts: z.array(z.object({
      id: z.string().describe("Identificador externo do contato (ex: o id da pessoa no seu CRM). Retornado no resultado para facilitar cruzamento."),
      phone: z.string().describe("Número do telefone para buscar. Aceita formatos variados."),
      name: z.string().optional().describe("Nome do contato (apenas para referência no resultado)."),
    })).describe("Lista de contatos para buscar. Máximo 50 por chamada."),
    device: z.string().optional().default(DEFAULT_DEVICE).describe("Aparelho (número conectado) no I-Bot: nome, parte do nome ou id. Padrão: IBOT_DEVICE; sem ela, busca em todos."),
    archived: z.boolean().optional().default(true).describe("Se true, quando não encontrar entre os não arquivados, tenta também os arquivados/fechados (padrão: true)."),
  },
  async ({ contacts, device, archived }) => {
    if (contacts.length > 50) {
      return { content: [{ type: "text", text: "Máximo 50 contatos por chamada. Divida em lotes menores." }] };
    }

    const p = await viaPainel(async () => {
      const out = [];
      for (const contact of contacts) {
        const c = await panel.findChatByPhone(SERVER, contact.phone, { archived, device });
        out.push(c
          ? { id: contact.id, name: contact.name || c.contact_name || "", phone: contact.phone, status: "ENCONTRADO", chat_id: c.chat_id, link: `${panel.baseUrl(SERVER)}/chats#${c.chat_id}`, matched_variant: c.matched_variant }
          : { id: contact.id, name: contact.name || "", phone: contact.phone, status: "NAO_ENCONTRADO", chat_id: null, link: null });
      }
      return out;
    });
    if (p?.fatal) return text(p.fatal);
    if (p) return text(formatBatch(p.ok));

    const session = await openBrowserWithSession();
    if (session.error) return { content: [{ type: "text", text: session.error }] };

    const { browser, page } = session;
    const results = [];

    try {
      const panelUrl = `${panel.baseUrl(SERVER)}/chats`;
      await page.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(5000);

      if (isLoginPage(page.url())) {
        await browser.close();
        return { content: [{ type: "text", text: `Sessão expirada. Execute \`ibot-mcp login\` para renovar.` }] };
      }

      // Seleciona aparelho uma vez (o filtro de arquivados é por contato, abaixo)
      if (device) await selectDevice(page, device);

      for (const contact of contacts) {
        // Busca em dois estados: não arquivados primeiro, depois arquivados
        // (o reload no fim do loop reseta o checkbox p/ OFF a cada contato).
        let result = await searchChatByPhone(page, contact.phone);
        if (!result && archived) {
          await enableArchivedFilter(page);
          result = await searchChatByPhone(page, contact.phone);
        }

        if (result) {
          results.push({
            id: contact.id,
            name: contact.name || "",
            phone: contact.phone,
            status: "ENCONTRADO",
            chat_id: result.chat_id,
            link: result.link,
            matched_variant: result.matched_variant,
          });
        } else {
          results.push({
            id: contact.id,
            name: contact.name || "",
            phone: contact.phone,
            status: "NAO_ENCONTRADO",
            chat_id: null,
            link: null,
          });
        }

        // Navegar de volta para a lista e reselecionar aparelho (o reload zera
        // o checkbox de arquivados — reativado por contato quando necessário).
        await page.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await sleep(3000);
        if (device) await selectDevice(page, device);
      }

      await browser.close();

      return text(formatBatch(results));
    } catch (err) {
      await browser.close().catch(() => {});
      // Retornar resultados parciais se houver
      if (results.length > 0) {
        return { content: [{ type: "text", text: `Erro após processar ${results.length} contatos: ${err.message}\nResultados parciais:\n${JSON.stringify(results)}` }] };
      }
      return { content: [{ type: "text", text: `Erro ao processar lote: ${err.message}` }] };
    }
  }
);

// ─── TOOL 12: LER MENSAGENS (PLAYWRIGHT) ────────────────────────────────────

server.tool(
  "ibot_read_messages",
  "Lê o histórico de mensagens de um chat no I-Bot, incluindo as ANOTAÇÕES internas na mesma linha do tempo. Usa a API interna do painel (sem navegador, ~250ms) e cai no Playwright se ela falhar. O histórico completo é acessível: aumente o limit e a resposta avisa quando ainda há mensagem mais antiga. Requer session.json (execute login.js primeiro).",
  {
    chat_id: z.string().describe("ID do chat (hash, ex: 686ede5b2333cb755c57d1a5). Obtido via ibot_get_chat_link ou ibot_get_chat_status."),
    limit: z.number().optional().default(50).describe("Quantidade máxima de mensagens a retornar (padrão: 50)"),
  },
  async ({ chat_id, limit }) => {
    const p = await viaPainel(() => panel.readMessages(SERVER, chat_id, limit));
    if (p?.fatal) return text(p.fatal);
    if (p) {
      const r = p.ok;
      if (r.mensagens.length === 0) return text(`Nenhuma mensagem encontrada no chat ${chat_id}.`);
      const header = `Chat ${chat_id} | status: ${r.chat_status} | ${r.mensagens.length} item(ns)`
        + (r.total_enviadas != null ? ` | ${r.total_enviadas} enviadas no total` : "")
        + (r.truncado ? ` | há histórico mais antigo — aumente o limit` : "");
      return text(header + "\n\n" + JSON.stringify(r.mensagens, null, 2));
    }

    const session = await openBrowserWithSession();
    if (session.error) return { content: [{ type: "text", text: session.error }] };

    const { browser, page } = session;
    try {
      const chatUrl = `${panel.baseUrl(SERVER)}/chats#${chat_id}`;
      await page.goto(chatUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(5000); // Aguardar SPA carregar (WebSocket mantém networkidle ativo)

      // Verificar se sessão expirou
      if (isLoginPage(page.url())) {
        await browser.close();
        return { content: [{ type: "text", text: `Sessão expirada. Execute \`ibot-mcp login\` para renovar.` }] };
      }

      // Aguardar container de mensagens carregar
      await page.waitForSelector("#chat_messages_app", { timeout: 15000 }).catch(() => null);
      await sleep(2000); // Aguardar mensagens renderizarem

      // Remover modais que possam bloquear scroll
      await page.evaluate(() => {
        const beamer = document.querySelector("#beamerPushModal");
        if (beamer) beamer.remove();
        document.querySelectorAll(".modal.show, .modal.active, [role='dialog'].active").forEach(el => el.remove());
        document.querySelectorAll(".modal-backdrop, .push-overlay").forEach(el => el.remove());
      });

      // Scroll para CIMA para carregar mais mensagens (mouse.wheel real)
      let msgCountBefore = 0;
      for (let scrollAttempt = 0; scrollAttempt < 10; scrollAttempt++) {
        const currentCount = await page.evaluate(() => document.querySelectorAll(".row_msg").length);
        if (currentCount >= limit) break;
        if (currentCount === msgCountBefore && scrollAttempt > 1) break;
        msgCountBefore = currentCount;

        await page.evaluate(() => {
          const beamer = document.querySelector("#beamerPushModal");
          if (beamer) beamer.remove();
          document.querySelectorAll(".modal-backdrop, .push-overlay").forEach(el => el.remove());
        });

        const chatContainer = await page.$("#chat_messages_app");
        if (chatContainer) {
          const box = await chatContainer.boundingBox();
          if (box) {
            await page.mouse.move(box.x + box.width / 2, box.y + 50);
            await page.mouse.wheel(0, -3000);
          }
        }
        await sleep(2500);
      }

      // Extrair mensagens do DOM (pega as últimas N)
      const messages = await page.evaluate((maxMessages) => {
        let currentDate = "";
        const container = document.querySelector("#chat_messages_app > div");
        if (!container) return [];

        const allMsgs = [];
        for (const child of container.children) {
          if (child.classList.contains("msg-data")) {
            currentDate = child.textContent.trim();
            continue;
          }
          if (!child.classList.contains("row_msg")) continue;

          const msgContainer = child.querySelector(".msg-container");
          if (!msgContainer) continue;

          const isOutgoing = msgContainer.classList.contains("bg-sent-msg");
          const remetente = isOutgoing ? "atendente" : "cliente";
          const textEl = msgContainer.querySelector("span.msg-contentT");
          const texto = textEl?.innerText?.trim() || "";

          if (!texto) {
            const audioEl = msgContainer.querySelector("audio");
            if (audioEl) {
              const timeEl = msgContainer.querySelector("span.msg-timestamp");
              allMsgs.push({ remetente, horario: timeEl?.textContent?.trim() || "", data: currentDate, texto: "[Áudio]" });
            }
            continue;
          }

          const timeEl = msgContainer.querySelector("span.msg-timestamp");
          allMsgs.push({ remetente, horario: timeEl?.textContent?.trim() || "", data: currentDate, texto });
        }

        return allMsgs.slice(-maxMessages);
      }, limit);

      await browser.close();

      if (messages.length === 0) {
        return {
          content: [{ type: "text", text: `Nenhuma mensagem encontrada no chat ${chat_id}. O chat pode estar vazio ou a estrutura da página mudou.` }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    } catch (err) {
      await browser.close().catch(() => {});
      return { content: [{ type: "text", text: `Erro ao ler mensagens: ${err.message}` }] };
    }
  }
);

// ─── TOOL 12b: BAIXAR MÍDIA DAS MENSAGENS ───────────────────────────────────
// Descoberta medida em 29/08/2026 (extração da conta pessoal S17, 40.7k áudios):
// o bucket de mídia do painel devolve 403 sem Referer e 200 com
// `Referer: <url do painel>/chats` — não exige cookie nem sessão.
// O arquivo mora em <account_id>/{received|sent|attached|unattached}/<nome>; quando
// o caminho registrado na mensagem falha, as outras pastas costumam ter o arquivo.

server.tool(
  "ibot_download_media",
  "Baixa mídia (áudio/imagem/vídeo/documento) das mensagens do I-Bot para o disco local. Passe as URLs do campo `arquivo.url` que ibot_read_messages retorna. Não requer sessão nem login: o S3 do painel exige apenas o header Referer (medido 29/08/2026). Se a URL registrada falhar, tenta as pastas alternativas do bucket (received/sent/attached/unattached). Retorna caminho e tamanho de cada arquivo salvo.",
  {
    urls: z.array(z.string()).min(1).describe("URLs completas dos arquivos (campo arquivo.url das mensagens de ibot_read_messages)"),
    dest_dir: z.string().optional().describe("Pasta local de destino (padrão: <pasta temporária do sistema>/ibot-media)"),
  },
  async ({ urls, dest_dir }) => {
    const { mkdir, writeFile } = await import("fs/promises");
    const dir = dest_dir || join(os.tmpdir(), "ibot-media");
    await mkdir(dir, { recursive: true });
    const referer = `${panel.baseUrl(SERVER)}/chats`;
    const PASTAS = ["received", "sent", "attached", "unattached"];
    const resultados = [];
    for (const url of urls) {
      const nome = (url.split("/").pop() || "").replace(/[^\w@.\- ]/g, "_");
      if (!nome) { resultados.push({ url, erro: "URL sem nome de arquivo" }); continue; }
      const candidatas = [...new Set([url, ...PASTAS.map((p) => url.replace(/\/[^/]+\/[^/]+$/, `/${p}/${nome}`))])];
      let salvo = null, ultimoErro = "";
      for (const u of candidatas) {
        try {
          const r = await fetch(u, { headers: { Referer: referer, "User-Agent": "Mozilla/5.0" } });
          if (!r.ok) { ultimoErro = `HTTP ${r.status}`; continue; }
          const buf = Buffer.from(await r.arrayBuffer());
          if (!buf.length) { ultimoErro = "arquivo vazio"; continue; }
          const destino = join(dir, nome);
          await writeFile(destino, buf);
          salvo = { arquivo: nome, path: destino, bytes: buf.length };
          break;
        } catch (e) { ultimoErro = e.message; }
      }
      resultados.push(salvo || { arquivo: nome, erro: ultimoErro || "não encontrado em nenhuma pasta" });
    }
    const ok = resultados.filter((r) => r.path).length;
    return text(`${ok}/${urls.length} arquivo(s) baixado(s) em ${dir}\n\n` + JSON.stringify(resultados, null, 2));
  }
);

// ─── TOOL 13: LISTAR CHATS COM FILTROS (PLAYWRIGHT) ─────────────────────────

server.tool(
  "ibot_list_chats",
  "Lista e filtra chats do painel I-Bot. Usa a API interna do painel (sem navegador, ~1s; 250 chats em ~1,8s) e cai no Playwright se ela falhar. Filtra por APARELHO (padrão: IBOT_DEVICE; vazio = todos), status, não lidas, arquivados, favoritos, tag, nome e número. Retorna nome, status, tags, aparelho, última mensagem, timestamp e não lidas. O retorno SEMPRE diz qual corte ocorreu (fim real da lista / teto do painel / limite pedido) — nunca corta em silêncio. TETO: a API interna PAGINA (medido 17/08/2026: 250 chats distintos numa consulta), mas o Playwright de fallback trava em 100 POR CONSULTA sem paginação (medido 14/08/2026: nenhum limit/offset traz o chat 101) — se o retorno avisar teto do painel, varrer além exige FATIAR por filtro e cruzar wa_chat_id. FORÇA DOS EIXOS, medida em produção: `device` é o mais forte (cada aparelho é uma janela própria; único jeito de isolar o inbound de UM número) > `department` (que é TAG, uma janela por tag) > status × order_by, que satura rápido — cruzar 6 status × 8 ordenações bate o teto em quase toda fatia e deixa um MIOLO inalcançável. Três armadilhas medidas: (1) whatsapp_number dá FALSO NEGATIVO — o chat existe, wa_chat_id igual ao buscado, e a busca volta vazia; a causa é o filtro de arquivados ser EXCLUSIVO (numa conta madura quase todo o histórico está arquivado), e leads já foram dados como 'sem chat' tendo chat ABERTO. Pela API interna isso está resolvido (busca por número que não acha nada refaz o pass entre arquivados e avisa), mas no fallback Playwright a armadilha continua: nunca conclua 'não tem chat' sem repetir com archived=true; (2) a ordenação padrão é por última mensagem, que AFUNDA o chat sem resposta (a última mensagem é a do cliente, antiga) — para caçar conversa parada sem dono use '-created', e para achar quem nem isso alcança use 'updated' (ascendente), que foi o que revelou leads invisíveis a 4 ciclos de varredura; (3) o nome do contato aqui é o do WhatsApp, não o do CRM ('.', '~', nome de empresa) — buscar pelo nome que está no CRM dá falso negativo. SEMPRE rode um controle positivo (um chat de estado já conhecido) na mesma virada: sem ele não há como distinguir 'não existe' de 'a fatia não alcança'.",
  {
    status: z.enum(["ABERTO", "EM ATENDIMENTO", "AGUARDANDO", "RESOLVIDO", "FECHADO", "INDEFINIDO"])
      .optional()
      .describe("Filtrar por status do chat."),
    unread_only: z.boolean().optional().default(false)
      .describe("Se true, mostra apenas chats com mensagens não lidas."),
    archived: z.boolean().optional().default(false)
      .describe("Se true, retorna SÓ os arquivados (o filtro do I-Bot é exclusivo, não soma com os ativos)."),
    favorited: z.boolean().optional().default(false)
      .describe("Se true, mostra apenas chats favoritados."),
    order_by: z.enum(["-updated", "updated", "-created", "created", "-new_messages", "new_messages", "-date_last_message", "date_last_message"])
      .optional()
      .describe("Ordenação. Padrão: -updated (mais recentes). Use -new_messages para ordenar por não lidas."),
    device: z.string().optional().default(DEFAULT_DEVICE)
      .describe("Filtrar pelo APARELHO (número de origem) que recebe o chat. Padrão: IBOT_DEVICE; vazio ('') lista de TODOS os aparelhos. Aceita trecho do rótulo (ex.: 'comercial', os últimos dígitos do número) ou o id bruto do aparelho. É o corte mais forte que o painel oferece — o mesmo número pode existir em dois aparelhos com conversas DIFERENTES, e no Playwright cada aparelho é uma janela própria de 100. Não casou = ERRO explícito com a lista real de aparelhos, nunca lista sem filtro se passando por lista filtrada."),
    responsavel: z.array(z.string()).optional()
      .describe("Filtrar por QUEM está com o chat — é o dropdown 'Usuário/Departamento' do painel. Aceita vários de uma vez (regra OU: devolve chat de qualquer um da lista), misturando PESSOA e DEPARTAMENTO livremente, porque no painel os dois vivem no mesmo seletor. Ex: [\"Maria Souza\", \"Financeiro\"]. Aceita nome completo, parte do nome, e-mail ou o id. Use [\"sem responsável\"] para os chats que NINGUÉM pegou — é o eixo pra caçar conversa órfã, e combina bem com order_by='-created'. Nome que não existe ou que casa com mais de um = ERRO explícito com a lista real, nunca lista sem filtro se passando por filtrada. NÃO funciona no fallback Playwright: se a API do painel estiver fora, a tool devolve erro em vez de lista sem esse filtro."),
    department: z.string().optional()
      .describe("ATENÇÃO — este filtro é de TAG, não de departamento (os labels de checkbox do painel são todos tags, ex.: 'Lead Quente', 'Cliente | Plano Gold'). O nome do parâmetro é herança e engana; para filtrar por departamento de verdade use `responsavel`. Vale como eixo de fatiamento: cada tag é uma janela própria de 100. Não casou = ERRO explícito com as tags disponíveis."),
    name: z.string().optional()
      .describe("Filtrar por nome do contato (busca parcial)."),
    whatsapp_number: z.string().optional()
      .describe("Filtrar por número WhatsApp (ex: 5511999990000)."),
    limit: z.number().optional().default(50)
      .describe("Máximo de chats a retornar (padrão: 50, máximo: 1000). Acima de 100 o scroll precisa carregar mais lotes: conte ~2s a cada 100."),
    offset: z.number().optional().default(0)
      .describe("Quantos chats descartar do início da lista (padrão: 0). Use com limit para paginar uma varredura grande sem reprocessar o mesmo trecho."),
  },
  async ({ status, unread_only, archived, favorited, order_by, device, responsavel, department, name, whatsapp_number, limit, offset }) => {
    // Teto do PAINEL no caminho Playwright, medido em 14/08/2026: o front serve no máximo
    // 100 chats por consulta e não pagina. A API interna PAGINA (page_num + total_chats),
    // então o caminho rápido não tem esse teto — mas os dois avisam qual corte ocorreu.
    const PANEL_MAX_CHATS = 100;
    const effectiveLimit = Math.min(Math.max(limit, 1), 1000);
    const effectiveOffset = Math.max(offset || 0, 0);
    // Quantos cards precisam existir na página: os que serão pulados + os que serão retornados.
    const targetCount = effectiveOffset + effectiveLimit;
    const filtraResponsavel = Array.isArray(responsavel) && responsavel.length > 0;

    // `department` (TAG por nome) só existe no Playwright; `responsavel` só existe na API
    // do painel. Juntos não têm caminho que atenda os dois — falha em vez de ignorar um.
    if (filtraResponsavel && department) {
      return text(
        "Não dá pra combinar `responsavel` com `department` na mesma chamada: o filtro de tag " +
        "(department) só existe no caminho Playwright e o de responsável só existe na API do painel. " +
        "Rode um de cada vez e cruze os wa_chat_id."
      );
    }

    // `department` é filtro de TAG por NOME e só existe no caminho Playwright (a API do
    // painel filtra por ids de usuário/grupo) — com ele, vai direto pro browser.
    const p = department ? null : await viaPainel(async () => {
      const args = { status, name, whatsapp_number, unread_only, favorited, order_by, device, responsavel, limit: targetCount };
      const achados = await panel.listChats(SERVER, { ...args, archived });
      // CAUSA RAIZ do falso negativo do filtro por número (medida 17/08/2026, 4 de 4):
      // o filtro de arquivados é EXCLUSIVO e ~19 mil dos ~20 mil chats estão arquivados,
      // então buscar um número sem pedir arquivados devolve vazio com o chat existindo.
      // Foi assim que 13 leads viraram "sem chat" tendo chat ABERTO. Segundo pass em vez
      // de aviso: buscar número e não achar tem que significar "não existe".
      if (achados.length === 0 && whatsapp_number && !archived) {
        const arq = await panel.listChats(SERVER, { ...args, archived: true });
        if (arq.length) return { chats: arq, soArquivados: true };
      }
      return { chats: achados, soArquivados: false };
    });
    if (p?.fatal) return text(p.fatal);
    if (p) {
      const chats = p.ok.chats.slice(effectiveOffset);
      if (chats.length === 0) return text("Nenhum chat encontrado com os filtros aplicados.");
      const filtros = [];
      if (status) filtros.push(`status=${status}`);
      if (name) filtros.push(`nome="${name}"`);
      if (whatsapp_number) filtros.push(`numero=${whatsapp_number}`);
      if (unread_only) filtros.push("apenas_nao_lidas");
      if (archived) filtros.push("arquivados");
      if (favorited) filtros.push("favoritos");
      if (order_by) filtros.push(`ordenacao=${order_by}`);
      filtros.push(device ? `aparelho="${device}"` : "todos_os_aparelhos");
      if (filtraResponsavel) filtros.push(`responsavel=${responsavel.map((r) => `"${r}"`).join(" ou ")}`);
      if (effectiveOffset) filtros.push(`offset=${effectiveOffset}`);
      // Mesma invariante do caminho Playwright: nunca cortar em silêncio. Aqui só existem
      // DOIS desfechos (a API pagina, então não há teto do painel): fim real ou corte pelo
      // limit pedido. "N chats" sem isso é lido como "só existem N".
      const cobertura = p.ok.chats.length >= targetCount
        ? ` ATENÇÃO: truncado no limite pedido (${effectiveLimit}${effectiveOffset ? ` + offset ${effectiveOffset}` : ""})`
          + ` — existem MAIS chats além destes. Repita com offset=${effectiveOffset + chats.length} ou aumente o limit.`
        : ` Fim da lista alcançado: ${p.ok.chats.length} chat(s) com os filtros atuais — não há mais além destes.`;
      const aviso = p.ok.soArquivados
        ? ` OBS: nada foi encontrado entre os chats ativos; estes vieram do pass de ARQUIVADOS (o filtro do I-Bot é exclusivo).`
        : "";
      return text(`Encontrados ${chats.length} chat(s) (filtros: ${filtros.join(", ")}).${aviso}${cobertura}\n\n` + JSON.stringify(chats, null, 2));
    }

    // Daqui pra baixo é o Playwright, que NÃO sabe filtrar por responsável. Devolver a
    // lista sem esse filtro seria o pior desfecho: lista de todo mundo com cara de lista
    // de uma pessoa. Erro explícito, igual ao aparelho inexistente.
    if (filtraResponsavel) {
      return text(
        `A API do painel está indisponível e o fallback (Playwright) não sabe filtrar por responsável. ` +
        `Não devolvo lista de propósito — sem o filtro ela viria com os chats de TODO MUNDO. ` +
        `Tente de novo em instantes; se persistir, rode \`ibot-mcp login\` e repita.`
      );
    }

    const session = await openBrowserWithSession();
    if (session.error) return { content: [{ type: "text", text: session.error }] };

    const { browser, page } = session;
    try {
      const panelUrl = `${panel.baseUrl(SERVER)}/chats`;
      await page.goto(panelUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(5000);

      if (isLoginPage(page.url())) {
        await browser.close();
        return { content: [{ type: "text", text: `Sessão expirada. Execute \`ibot-mcp login\` para renovar.` }] };
      }

      // Remover modais (Beamer push, etc.)
      await page.evaluate(() => {
        const beamer = document.querySelector("#beamerPushModal");
        if (beamer) beamer.remove();
        document.querySelectorAll(".modal.show, .modal.active, [role='dialog'].active").forEach(el => el.remove());
        document.querySelectorAll(".modal-backdrop, .push-overlay").forEach(el => el.remove());
      });

      // ── Aplicar filtros ──

      // Nome
      if (name) {
        const nameInput = await page.$("#inChatsName");
        if (nameInput) {
          await nameInput.fill(name);
          await page.keyboard.press("Enter");
          await sleep(2000);
        }
      }

      // Número WhatsApp
      if (whatsapp_number) {
        const phoneInput = await page.$("#inChatsWhatsappNum");
        if (phoneInput) {
          await phoneInput.fill(normalizePhone(whatsapp_number));
          await page.keyboard.press("Enter");
          await sleep(2000);
        }
      }

      // Aparelho (número de origem) — MEDIDO 14/08/2026, card 0x7jxz3qdsp4.
      // É o corte mais forte do painel: cada aparelho é uma janela PRÓPRIA de 100. Sem ele não há
      // como isolar o inbound de um número (ex: o disparador), e uma varredura que cruza status ×
      // ordenação bate o teto em todas as fatias sem nunca cobrir o miolo.
      // Aplicado ANTES do status de propósito: trocar o aparelho recarrega a lista.
      // FALHA RUIDOSA: rótulo que não casa devolve ERRO com a lista real. O `department` abaixo
      // errava justamente aqui — clicava num label inexistente e devolvia lista SEM filtro como se
      // estivesse filtrada, que é o pior desfecho possível numa varredura.
      let deviceAplicado = null;
      if (device) {
        const alvo = String(device).trim().toLowerCase();
        const opcoes = await page.evaluate(() => {
          const sel = document.querySelector("#selChatsDevice");
          if (!sel) return null;
          return [...sel.options].map((o) => ({ value: o.value, label: (o.textContent || "").trim() }));
        });
        if (!opcoes) {
          await browser.close();
          return { content: [{ type: "text", text: "FALHA DE LEITURA: o seletor de aparelho (#selChatsDevice) não existe nesta página — o painel pode ter mudado. Não filtrei nada e não devolvo lista, pra não passar lista sem filtro por lista filtrada." }] };
        }
        const validas = opcoes.filter((o) => o.value);
        const casada = validas.find((o) => o.value.toLowerCase() === alvo)
          || validas.find((o) => o.label.toLowerCase() === alvo)
          || validas.find((o) => o.label.toLowerCase().includes(alvo))
          || validas.find((o) => o.label.replace(/\D/g, "").includes(alvo.replace(/\D/g, "")) && alvo.replace(/\D/g, "").length >= 4);
        if (!casada) {
          await browser.close();
          return { content: [{ type: "text", text: `Aparelho "${device}" não casou com nenhuma opção do painel. Disponíveis: ${validas.map((o) => `"${o.label}" (id ${o.value})`).join(" | ")}. Nada foi filtrado e nenhuma lista é devolvida de propósito.` }] };
        }
        await page.selectOption("#selChatsDevice", casada.value).catch(() => {});
        deviceAplicado = casada.label;
        await sleep(2500);
      }

      // Status
      if (status) {
        await page.selectOption("#selChatsStatus", status).catch(() => {});
        await sleep(2000);
      }

      // Ordenação
      if (order_by) {
        await page.selectOption("#selChatsOrder", order_by).catch(() => {});
        await sleep(2000);
      }

      // Toggle: Não lidas
      if (unread_only) {
        const unreadCb = await page.$(".list__single__filter.unread input[type='checkbox']");
        if (unreadCb) { await unreadCb.click(); await sleep(2000); }
      }

      // Toggle: Arquivados
      if (archived) {
        const archivedCb = await page.$(".list__single__filter.archived input[type='checkbox']");
        if (archivedCb) { await archivedCb.click(); await sleep(2000); }
      }

      // Toggle: Favoritos
      if (favorited) {
        const favCb = await page.$(".list__single__filter.favorited input[type='checkbox']");
        if (favCb) { await favCb.click(); await sleep(2000); }
      }

      // TAG (o parâmetro se chama `department` por herança, mas os 125 labels de checkbox do painel
      // são TAGS — medido 14/08/2026). Antes esta busca falhava CALADA: label que não existe não era
      // clicado e a lista voltava sem filtro, indistinguível de uma lista filtrada. Agora devolve erro.
      let tagAplicada = null;
      if (department) {
        const r = await page.evaluate((deptName) => {
          const alvo = deptName.trim().toLowerCase();
          const labels = [...document.querySelectorAll("label")].filter((l) => l.querySelector("input[type='checkbox']"));
          const texto = (l) => (l.textContent || "").trim().replace(/\s+/g, " ");
          const exata = labels.find((l) => texto(l).toLowerCase() === alvo);
          const parcial = exata || labels.find((l) => texto(l).toLowerCase().includes(alvo));
          if (!parcial) {
            return { ok: false, disponiveis: labels.map(texto).filter(Boolean).slice(0, 130) };
          }
          parcial.querySelector("input[type='checkbox']").click();
          return { ok: true, casou: texto(parcial) };
        }, department);
        if (!r.ok) {
          await browser.close();
          return { content: [{ type: "text", text: `Tag "${department}" não casou com nenhum label do painel (este filtro é de TAG, não de departamento). Disponíveis: ${r.disponiveis.join(" | ")}. Nada foi filtrado e nenhuma lista é devolvida de propósito — lista sem filtro passando por filtrada já produziu conclusão errada neste projeto.` }] };
        }
        tagAplicada = r.casou;
        await sleep(2000);
      }

      // Aguardar lista estabilizar
      await sleep(1000);

      // ── Scroll para carregar cards lazy-loaded ──
      // MEDIDO NO PAINEL EM 14/08/2026 (não presuma outra coisa sem remedir):
      //  - o container scrollável é `.list__cards-wrapper`. Os 3 seletores usados antes
      //    (.list__user-cards, .list__container, [class*='chat-list']) NÃO existem, então o
      //    scroll nunca rodava — e falhava calado, no `if (!container) return`;
      //  - o painel devolve NO MÁXIMO 100 chats por consulta e NÃO pagina: rolar até o fim por
      //    scrollTop, por roda do mouse e por scrollIntoView deixa a lista em 100 e não dispara
      //    UM XHR sequer. Ou seja, o teto de 100 é do servidor deles, não nosso.
      // Consequência prática: para varrer mais de 100, REFINE O FILTRO (status, não-lidas,
      // ordenação, departamento, nome) e cruze wa_chat_id — pedir limit maior não traz mais.
      const scrollReport = await page.evaluate(async (targetCount) => {
        const container = document.querySelector(".list__cards-wrapper")
          || document.querySelector(".list__user-cards")
          || document.querySelector(".list__container")
          || document.querySelector("[class*='chat-list']");
        const count = () => document.querySelectorAll(".list__user-card").length;
        if (!container) return { containerFound: false, loaded: count(), saturated: false, rounds: 0 };

        let prevCount = -1;
        let stagnantRounds = 0;
        let rounds = 0;
        // Teto de segurança proporcional ao alvo (cada lote traz ~20-30 cards), nunca infinito.
        const maxRounds = Math.min(400, Math.ceil(targetCount / 10) + 20);

        while (rounds < maxRounds) {
          const current = count();
          if (current >= targetCount) break;
          stagnantRounds = current === prevCount ? stagnantRounds + 1 : 0;
          if (stagnantRounds >= 3) break; // 3 rodadas sem um card novo = fim real da lista
          prevCount = current;
          container.scrollTop = container.scrollHeight;
          rounds++;
          await new Promise(r => setTimeout(r, 800));
        }
        const loaded = count();
        return {
          containerFound: true,
          loaded,
          saturated: loaded < targetCount, // acabaram os chats antes de bater o alvo
          rounds,
        };
      }, targetCount);
      await sleep(1000);

      // ── Extrair dados dos chat cards ──
      const chats = await page.evaluate(({ maxChats, skip }) => {
        const result = [];
        const allCards = document.querySelectorAll(".list__user-card");
        const cards = skip > 0 ? Array.from(allCards).slice(skip) : allCards;

        for (const card of cards) {
          if (result.length >= maxChats) break;

          // Nome do contato
          const nameEl = card.querySelector(".user-name");
          const contactName = nameEl?.textContent?.trim() || "";

          // Prévia da última mensagem (texto completo no atributo title)
          const msgEl = card.querySelector(".user-msg span[title]");
          const lastMessage = msgEl?.getAttribute("title") || msgEl?.textContent?.trim() || "";

          // Status (span.attendance__status com texto ABERTO/AGUARDANDO/EM ATENDI/etc)
          const statusEl = card.querySelector("span.attendance__status");
          let chatStatus = statusEl?.textContent?.trim() || "";
          if (chatStatus === "EM ATENDI") chatStatus = "EM ATENDIMENTO";

          // Contagem de não lidas (span.attendance__number)
          const unreadEl = card.querySelector("span.attendance__number");
          const unreadCount = unreadEl ? parseInt(unreadEl.textContent.trim(), 10) || 0 : 0;

          // Timestamp (.attendance__hour span)
          const timeEl = card.querySelector(".attendance__hour span");
          const timestamp = timeEl?.textContent?.trim() || "";

          // chat_id: extrair via Vue 3 __vueParentComponent.props.card.id
          let chatId = "";
          let waChatId = "";
          let chatKind = "";
          try {
            const vue3 = card.__vueParentComponent;
            const cardData = vue3?.props?.card;
            if (cardData) {
              chatId = cardData.id || cardData._id || "";
              waChatId = cardData.wa_chat_id || "";
              chatKind = cardData.kind || "";
            }
          } catch (e) { /* ignore */ }

          // Fallback Vue 2 / data attrs (compat antigos)
          if (!chatId) {
            chatId = card.getAttribute("data-id")
              || card.getAttribute("data-chat-id")
              || card.getAttribute("data-chat")
              || "";
            if (!chatId) {
              try {
                const vue = card.__vue__;
                if (vue) chatId = vue.chat?._id || vue.chat?.id || "";
              } catch (e) { /* ignore */ }
            }
          }

          result.push({
            contact_name: contactName,
            status: chatStatus,
            last_message: lastMessage,
            timestamp,
            unread_count: unreadCount,
            chat_id: chatId,
            wa_chat_id: waChatId,
            kind: chatKind,
          });
        }

        return result;
      }, { maxChats: effectiveLimit, skip: effectiveOffset });

      await browser.close();

      if (chats.length === 0) {
        const vazio = scrollReport.containerFound
          ? "Nenhum chat encontrado com os filtros aplicados."
          : "Nenhum chat retornado E a lista não foi localizada na página (o seletor do painel pode ter mudado). "
            + "Trate como FALHA DE LEITURA, não como ausência de chats.";
        return { content: [{ type: "text", text: vazio }] };
      }

      // Resumo dos filtros aplicados
      const filtersApplied = [];
      if (status) filtersApplied.push(`status=${status}`);
      if (name) filtersApplied.push(`nome="${name}"`);
      if (whatsapp_number) filtersApplied.push(`numero=${whatsapp_number}`);
      if (unread_only) filtersApplied.push("apenas_nao_lidas");
      if (archived) filtersApplied.push("arquivados");
      if (favorited) filtersApplied.push("favoritos");
      filtersApplied.push(deviceAplicado ? `aparelho="${deviceAplicado}"` : "todos_os_aparelhos");
      if (tagAplicada) filtersApplied.push(`tag="${tagAplicada}"`);
      if (order_by) filtersApplied.push(`ordenacao=${order_by}`);

      if (effectiveOffset) filtersApplied.push(`offset=${effectiveOffset}`);

      // Cobertura explícita: sem isto, quem chama lê "N chats" e conclui "só existem N".
      // Foi assim que uma varredura de leads deu a lista por completa faltando gente (13-14/08).
      // Três desfechos DIFERENTES, que antes se confundiam num silêncio só:
      let cobertura;
      if (scrollReport.loaded >= PANEL_MAX_CHATS) {
        cobertura = ` ATENÇÃO — TETO DO PAINEL: o I-Bot entrega no máximo ${PANEL_MAX_CHATS} chats por consulta e não pagina.`
          + ` Há chats FORA desta janela e nenhum limit/offset maior os alcança:`
          + ` para varrer o resto, refine o filtro (status, unread_only, order_by, department, name) e cruze wa_chat_id.`
          + ` Ordenação importa: '-created' revela chat parado sem resposta, que a ordem padrão (última mensagem) afunda.`;
      } else if (scrollReport.saturated) {
        cobertura = ` Fim da lista alcançado: ${scrollReport.loaded} card(s) com os filtros atuais — abaixo do teto do painel, então não há mais além destes.`;
      } else {
        cobertura = ` ATENÇÃO: truncado no limite pedido (${effectiveLimit}${effectiveOffset ? ` + offset ${effectiveOffset}` : ""})`
          + ` — existem MAIS chats além destes. Repita com offset=${effectiveOffset + chats.length} ou aumente o limit.`;
      }
      if (!scrollReport.containerFound) {
        cobertura += ` AVISO: container da lista não localizado (esperado '.list__cards-wrapper') — o scroll não rodou.`
          + ` O painel pode ter mudado de layout: trate o resultado como possivelmente parcial.`;
      }

      const summary = `Encontrados ${chats.length} chat(s)${filtersApplied.length ? ` (filtros: ${filtersApplied.join(", ")})` : ""}.${cobertura}`;

      return {
        content: [{ type: "text", text: summary + "\n\n" + JSON.stringify(chats, null, 2) }],
      };
    } catch (err) {
      await browser.close().catch(() => {});
      return { content: [{ type: "text", text: `Erro ao listar chats: ${err.message}` }] };
    }
  }
);

// ─── TOOL 15: LER CAMPOS PERSONALIZADOS (PAINEL) ────────────────────────────

server.tool(
  "ibot_read_custom_fields",
  "Lê os campos personalizados de um chat no I-Bot (Empresa, Email, CRM, etc). Usa a API interna do painel — não abre navegador. Latência: <1s. Requer session.json (execute login.js primeiro).",
  {
    chat_id: z.string().describe("ID do chat (hash de 24 caracteres). Obtido via ibot_get_chat_link ou ibot_list_chats."),
    only_filled: z.boolean().optional().default(false).describe("Se true, retorna apenas os campos que têm valor preenchido."),
  },
  async ({ chat_id, only_filled }) => {
    const p = await viaPainel(() => panel.readCustomFields(SERVER, chat_id));
    if (p?.fatal) return text(p.fatal);
    if (!p) return text("Não foi possível ler os campos personalizados: a API do painel mudou. Verifique o endpoint /chat/custom_fields.");

    const fields = only_filled ? p.ok.filter(f => f.valor !== "") : p.ok;
    if (fields.length === 0) return text(`Nenhum campo personalizado${only_filled ? " preenchido" : ""} no chat ${chat_id}.`);
    return text(`${fields.length} campo(s) no chat ${chat_id}:\n\n` + JSON.stringify(fields, null, 2));
  }
);

// ─── TOOL 16: LER TAGS DO CHAT (PAINEL) ─────────────────────────────────────

server.tool(
  "ibot_read_tags",
  "Lê as tags aplicadas a um chat no I-Bot. Usa a API interna do painel — não abre navegador. Latência: <1s. Requer session.json.",
  {
    chat_id: z.string().describe("ID do chat (hash de 24 caracteres)."),
  },
  async ({ chat_id }) => {
    const p = await viaPainel(() => panel.readTags(SERVER, chat_id));
    if (p?.fatal) return text(p.fatal);
    if (!p) return text("Não foi possível ler as tags: a API do painel mudou. Verifique o endpoint /chat_tags.");
    if (p.ok.length === 0) return text(`Nenhuma tag aplicada ao chat ${chat_id}.`);
    return text(`Tags do chat ${chat_id}: ${p.ok.join(", ")}`);
  }
);

// ─── START ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// Cleanup: encerra o processo quando o stdin do pai (Claude Code/Desktop) fechar.
// Sem isso, em Windows o processo node fica zumbi após restart do host.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
