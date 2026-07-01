import axios from "axios";

let cachedCookie = null;

async function getOdooSessionCookie() {
  if (cachedCookie) {
    return cachedCookie;
  }

  const response = await axios.post(
    `${process.env.ODOO_URL}/web/session/authenticate`,
    {
      jsonrpc: "2.0",
      params: {
        db: process.env.ODOO_DB,
        login: process.env.ODOO_SERVICE_LOGIN,
        password: process.env.ODOO_SERVICE_PASSWORD,
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  const data = response.data;

  if (!data.result || !data.result.uid) {
    throw new Error("Odoo service login failed");
  }

  const cookies = response.headers["set-cookie"];

  if (!cookies || !cookies.length) {
    throw new Error("Odoo session cookie not found");
  }

  cachedCookie = cookies.map((cookie) => cookie.split(";")[0]).join("; ");

  return cachedCookie;
}

function buildCallKwPayload(model, method, params = {}) {
  let args = [];
  let kwargs = {};

  if (method === "search_read") {
    args = [params.domain || []];
    kwargs = {
      fields: params.fields || [],
    };

    if (params.limit !== undefined) kwargs.limit = params.limit;
    if (params.offset !== undefined) kwargs.offset = params.offset;
    if (params.order !== undefined) kwargs.order = params.order;
  }

  else if (method === "create") {
    args = [params.vals_list || []];
  }

  else if (method === "write") {
    args = [params.ids || [], params.vals || {}];
  }

  else if (method === "action_confirm") {
    args = [params.ids || []];
  }

  else if (method === "message_post") {
    args = [params.ids?.[0]];
    // Callers may pass the full message_post kwargs (body, attachment_ids, etc.)
    // under `params.kwargs`. Forward those when present so the chatter body and
    // attachments actually reach Odoo; fall back to the flat-param shape.
    kwargs = params.kwargs
      ? {
          message_type: "comment",
          subtype_xmlid: "mail.mt_note",
          ...params.kwargs,
          body: params.kwargs.body || "",
        }
      : {
          body: params.body || "",
          message_type: params.message_type || "comment",
          subtype_xmlid: params.subtype_xmlid || "mail.mt_note",
        };
  }

  else {
    args = params.args || [];
    kwargs = params.kwargs || {};
  }

  return {
    jsonrpc: "2.0",
    method: "call",
    params: {
      model,
      method,
      args,
      kwargs,
    },
  };
}

export async function odooCall(model, method, params = {}) {
  try {
    const cookie = await getOdooSessionCookie();
    const payload = buildCallKwPayload(model, method, params);

    const response = await axios.post(
      `${process.env.ODOO_URL}/web/dataset/call_kw/${model}/${method}`,
      payload,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
        },
      }
    );

    if (response.data.error) {
      console.log("ODOO CALL_KW ERROR:", response.data.error);
      throw new Error(
        response.data.error.data?.message ||
        response.data.error.message ||
        "Odoo call_kw error"
      );
    }

    return response.data.result;
  } catch (err) {
    console.log("ODOO ERROR:", err.response?.data || err.message);
    cachedCookie = null;
    throw err;
  }
}

export async function odooAuthenticate(login, password) {
  const response = await axios.post(
    `${process.env.ODOO_URL}/web/session/authenticate`,
    {
      jsonrpc: "2.0",
      params: {
        db: process.env.ODOO_DB,
        login,
        password,
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
    }
  );

  const data = response.data;

  if (!data.result || !data.result.uid) {
    return null;
  }

  return {
    uid: data.result.uid,
    name: data.result.name,
    login: data.result.username || login,
    partner_id: data.result.partner_id,
  };
}