import { createClient } from '@libsql/client/web';

function getDB(env) {
  return createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function csvCell(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

// Auto-create tables on first request if they don't exist yet
let schemaInitialized = false;
async function ensureSchema(db) {
  if (schemaInitialized) return;
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS buyers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      contact_person TEXT,
      phone_whatsapp TEXT,
      email TEXT,
      destination_port TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      contact_person TEXT,
      phone_whatsapp TEXT,
      email TEXT,
      city_country TEXT,
      specialties TEXT,
      certifications TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL,
      buyer_id INTEGER NOT NULL,
      currency TEXT DEFAULT 'USD',
      incoterms TEXT DEFAULT 'FOB',
      target_delivery_date TEXT,
      status TEXT DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (buyer_id) REFERENCES buyers(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      specifications TEXT,
      required_qty REAL DEFAULT 0,
      unit TEXT DEFAULT 'KG',
      buyer_target_price REAL DEFAULT 0,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS item_quotes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER NOT NULL,
      supplier_id INTEGER NOT NULL,
      quoted_price REAL DEFAULT 0,
      moq REAL DEFAULT 0,
      lead_time_days INTEGER DEFAULT 0,
      status TEXT DEFAULT '1 - RFQ Sent',
      sample_awb TEXT DEFAULT '',
      remarks TEXT DEFAULT '',
      is_selected INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );
  `);
  schemaInitialized = true;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '');
  const method = request.method.toUpperCase();

  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    return jsonResponse(
      { error: 'Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN in Cloudflare Pages Environment Variables.' },
      500
    );
  }

  const db = getDB(env);

  try {
    await ensureSchema(db);

    // 1. GET /api/directory
    if (path === '/api/directory' && method === 'GET') {
      const [buyers, suppliers] = await Promise.all([
        db.execute('SELECT * FROM buyers ORDER BY company_name ASC'),
        db.execute('SELECT * FROM suppliers ORDER BY company_name ASC'),
      ]);
      return jsonResponse({ buyers: buyers.rows, suppliers: suppliers.rows });
    }

    // 2. POST /api/buyers
    if (path === '/api/buyers' && method === 'POST') {
      const { company_name, contact_person, phone_whatsapp, email, destination_port, notes } = await request.json();
      const result = await db.execute({
        sql: `INSERT INTO buyers (company_name, contact_person, phone_whatsapp, email, destination_port, notes)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [company_name, contact_person || '', phone_whatsapp || '', email || '', destination_port || '', notes || ''],
      });
      return jsonResponse(result.rows[0]);
    }

    // 3. PUT & DELETE /api/buyers/:id
    const buyerMatch = path.match(/^\/api\/buyers\/(\d+)$/);
    if (buyerMatch) {
      const buyerId = buyerMatch[1];
      if (method === 'PUT') {
        const { company_name, contact_person, phone_whatsapp, email, destination_port, notes } = await request.json();
        await db.execute({
          sql: `UPDATE buyers
                SET company_name = ?, contact_person = ?, phone_whatsapp = ?, email = ?, destination_port = ?, notes = ?
                WHERE id = ?`,
          args: [
            company_name,
            contact_person || '',
            phone_whatsapp || '',
            email || '',
            destination_port || '',
            notes || '',
            buyerId,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        const check = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM orders WHERE buyer_id = ?', args: [buyerId] });
        if (Number(check.rows[0].count) > 0) {
          return jsonResponse({ error: 'Cannot delete buyer: they are linked to existing orders.' }, 400);
        }
        await db.execute({ sql: 'DELETE FROM buyers WHERE id = ?', args: [buyerId] });
        return jsonResponse({ success: true });
      }
    }

    // 4. POST /api/suppliers
    if (path === '/api/suppliers' && method === 'POST') {
      const { company_name, contact_person, phone_whatsapp, email, city_country, specialties, certifications } =
        await request.json();
      const result = await db.execute({
        sql: `INSERT INTO suppliers (company_name, contact_person, phone_whatsapp, email, city_country, specialties, certifications)
              VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [
          company_name,
          contact_person || '',
          phone_whatsapp || '',
          email || '',
          city_country || '',
          specialties || '',
          certifications || '',
        ],
      });
      return jsonResponse(result.rows[0]);
    }

    // 5. PUT & DELETE /api/suppliers/:id
    const supplierMatch = path.match(/^\/api\/suppliers\/(\d+)$/);
    if (supplierMatch) {
      const supplierId = supplierMatch[1];
      if (method === 'PUT') {
        const { company_name, contact_person, phone_whatsapp, email, city_country, specialties, certifications } =
          await request.json();
        await db.execute({
          sql: `UPDATE suppliers
                SET company_name = ?, contact_person = ?, phone_whatsapp = ?, email = ?, city_country = ?, specialties = ?, certifications = ?
                WHERE id = ?`,
          args: [
            company_name,
            contact_person || '',
            phone_whatsapp || '',
            email || '',
            city_country || '',
            specialties || '',
            certifications || '',
            supplierId,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        const check = await db.execute({
          sql: 'SELECT COUNT(*) AS count FROM item_quotes WHERE supplier_id = ?',
          args: [supplierId],
        });
        if (Number(check.rows[0].count) > 0) {
          return jsonResponse({ error: 'Cannot delete supplier: they are assigned to active product quotes.' }, 400);
        }
        await db.execute({ sql: 'DELETE FROM suppliers WHERE id = ?', args: [supplierId] });
        return jsonResponse({ success: true });
      }
    }

    // 6. GET & POST /api/orders
    if (path === '/api/orders') {
      if (method === 'GET') {
        const ordersRes = await db.execute(`
          SELECT o.*, b.company_name AS buyer_name, b.contact_person AS buyer_contact,
                 b.phone_whatsapp AS buyer_phone, b.email AS buyer_email, b.destination_port
          FROM orders o
          JOIN buyers b ON o.buyer_id = b.id
          ORDER BY o.id DESC
        `);

        const itemsRes = await db.execute(`SELECT * FROM order_items ORDER BY id ASC`);
        const quotesRes = await db.execute(`
          SELECT q.*, s.company_name AS supplier_name, s.contact_person AS supplier_contact,
                 s.phone_whatsapp AS supplier_phone, s.email AS supplier_email,
                 s.city_country, s.certifications
          FROM item_quotes q
          JOIN suppliers s ON q.supplier_id = s.id
          ORDER BY q.is_selected DESC, q.quoted_price ASC
        `);

        const quotesByItem = {};
        for (const q of quotesRes.rows) {
          if (!quotesByItem[q.order_item_id]) quotesByItem[q.order_item_id] = [];
          quotesByItem[q.order_item_id].push(q);
        }

        const itemsByOrder = {};
        for (const item of itemsRes.rows) {
          item.quotes = quotesByItem[item.id] || [];
          if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
          itemsByOrder[item.order_id].push(item);
        }

        const fullOrders = ordersRes.rows.map((order) => ({
          ...order,
          items: itemsByOrder[order.id] || [],
        }));

        return jsonResponse(fullOrders);
      }

      if (method === 'POST') {
        const { order_code, buyer_id, currency, incoterms, target_delivery_date, products } = await request.json();
        const orderRes = await db.execute({
          sql: `INSERT INTO orders (order_code, buyer_id, currency, incoterms, target_delivery_date)
                VALUES (?, ?, ?, ?, ?) RETURNING *`,
          args: [order_code, buyer_id, currency || 'USD', incoterms || 'FOB', target_delivery_date || ''],
        });
        const orderId = orderRes.rows[0].id;

        if (Array.isArray(products)) {
          for (const p of products) {
            if (!p.product_name || !p.product_name.trim()) continue;
            await db.execute({
              sql: `INSERT INTO order_items (order_id, product_name, specifications, required_qty, unit, buyer_target_price)
                    VALUES (?, ?, ?, ?, ?, ?)`,
              args: [
                orderId,
                p.product_name.trim(),
                p.specifications || '',
                Number(p.required_qty) || 0,
                p.unit || 'KG',
                Number(p.buyer_target_price) || 0,
              ],
            });
          }
        }
        return jsonResponse({ id: orderId });
      }
    }

    // 7. POST /api/orders/:orderId/items
    const orderItemsMatch = path.match(/^\/api\/orders\/(\d+)\/items$/);
    if (orderItemsMatch && method === 'POST') {
      const orderId = orderItemsMatch[1];
      const { product_name, specifications, required_qty, unit, buyer_target_price } = await request.json();
      const result = await db.execute({
        sql: `INSERT INTO order_items (order_id, product_name, specifications, required_qty, unit, buyer_target_price)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [
          orderId,
          product_name,
          specifications || '',
          Number(required_qty) || 0,
          unit || 'KG',
          Number(buyer_target_price) || 0,
        ],
      });
      return jsonResponse(result.rows[0]);
    }

    // 8. GET /api/orders/:orderId/export
    const exportMatch = path.match(/^\/api\/orders\/(\d+)\/export$/);
    if (exportMatch && method === 'GET') {
      const orderId = exportMatch[1];
      const mode = url.searchParams.get('mode') === 'awarded' ? 'awarded' : 'all';

      const orderRes = await db.execute({
        sql: `SELECT o.*, b.company_name AS buyer_name, b.contact_person AS buyer_contact,
                     b.phone_whatsapp AS buyer_phone, b.email AS buyer_email, b.destination_port
              FROM orders o
              JOIN buyers b ON o.buyer_id = b.id
              WHERE o.id = ?`,
        args: [orderId],
      });

      if (orderRes.rows.length === 0) {
        return new Response('Order not found', { status: 404 });
      }
      const order = orderRes.rows[0];

      const itemsRes = await db.execute({
        sql: `SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC`,
        args: [order.id],
      });

      const quotesRes = await db.execute({
        sql: `SELECT q.*, s.company_name AS supplier_name, s.contact_person AS supplier_contact,
                     s.phone_whatsapp AS supplier_phone, s.email AS supplier_email,
                     s.city_country, s.certifications
              FROM item_quotes q
              JOIN suppliers s ON q.supplier_id = s.id
              WHERE q.order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)
              ORDER BY q.is_selected DESC, q.quoted_price ASC`,
        args: [order.id],
      });

      const quotesByItem = {};
      for (const q of quotesRes.rows) {
        if (!quotesByItem[q.order_item_id]) quotesByItem[q.order_item_id] = [];
        quotesByItem[q.order_item_id].push(q);
      }

      const headers = [
        'Order Code', 'Buyer Company', 'Buyer Contact', 'Buyer Phone', 'Destination Port',
        'Incoterms', 'Currency', 'Delivery Deadline', 'Product #', 'Product Name',
        'Specifications', 'Required Qty', 'Unit', 'Buyer Target Price', 'Awarded?',
        'Supplier Company', 'Supplier Contact', 'Supplier Phone/WA', 'Supplier Email',
        'Supplier Location', 'Certifications', 'Supplier Quoted Price', 'Margin %',
        'Est. Total Profit', 'MOQ', 'Lead Time (Days)', 'Sourcing Status', 'Sample AWB', 'Remarks',
      ];

      const rows = [headers.map(csvCell).join(',')];

      itemsRes.rows.forEach((item, idx) => {
        let itemQuotes = quotesByItem[item.id] || [];
        if (mode === 'awarded') {
          itemQuotes = itemQuotes.filter((q) => Number(q.is_selected) === 1);
        }

        if (itemQuotes.length === 0) {
          rows.push(
            [
              order.order_code, order.buyer_name, order.buyer_contact, order.buyer_phone,
              order.destination_port, order.incoterms, order.currency, order.target_delivery_date,
              idx + 1, item.product_name, item.specifications, item.required_qty, item.unit,
              item.buyer_target_price, mode === 'awarded' ? 'PENDING AWARD' : 'NO SUPPLIER',
              '', '', '', '', '', '', '', '', '', '', '', '', '', '',
            ].map(csvCell).join(',')
          );
        } else {
          for (const q of itemQuotes) {
            const target = Number(item.buyer_target_price) || 0;
            const quote = Number(q.quoted_price) || 0;
            const qty = Number(item.required_qty) || 0;
            const marginPct = target > 0 && quote > 0 ? (((target - quote) / target) * 100).toFixed(2) + '%' : '';
            const totalProfit = target > 0 && quote > 0 && qty > 0 ? ((target - quote) * qty).toFixed(2) : '';

            rows.push(
              [
                order.order_code, order.buyer_name, order.buyer_contact, order.buyer_phone,
                order.destination_port, order.incoterms, order.currency, order.target_delivery_date,
                idx + 1, item.product_name, item.specifications, item.required_qty, item.unit,
                item.buyer_target_price, Number(q.is_selected) === 1 ? 'YES - AWARDED' : 'No',
                q.supplier_name, q.supplier_contact, q.supplier_phone, q.supplier_email,
                q.city_country, q.certifications, q.quoted_price, marginPct, totalProfit,
                q.moq, q.lead_time_days, q.status, q.sample_awb, q.remarks,
              ].map(csvCell).join(',')
            );
          }
        }
      });

      const safeCode = order.order_code.replace(/[^a-zA-Z0-9-_]/g, '_');
      const filename = `${safeCode}_${mode === 'awarded' ? 'Awarded_Summary' : 'Full_Sourcing_Tracker'}.csv`;

      return new Response('\uFEFF' + rows.join('\r\n'), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      });
    }

    // 9. DELETE /api/items/:itemId
    const itemMatch = path.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch && method === 'DELETE') {
      await db.execute({ sql: `DELETE FROM order_items WHERE id = ?`, args: [itemMatch[1]] });
      return jsonResponse({ success: true });
    }

    // 10. POST /api/items/:itemId/quotes
    const itemQuotesMatch = path.match(/^\/api\/items\/(\d+)\/quotes$/);
    if (itemQuotesMatch && method === 'POST') {
      const itemId = itemQuotesMatch[1];
      const { supplier_id, quoted_price, moq, lead_time_days, status, sample_awb, remarks } = await request.json();
      const result = await db.execute({
        sql: `INSERT INTO item_quotes (order_item_id, supplier_id, quoted_price, moq, lead_time_days, status, sample_awb, remarks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [
          itemId,
          supplier_id,
          Number(quoted_price) || 0,
          Number(moq) || 0,
          Number(lead_time_days) || 0,
          status || '1 - RFQ Sent',
          sample_awb || '',
          remarks || '',
        ],
      });
      return jsonResponse(result.rows[0]);
    }

    // 11. PUT & DELETE /api/quotes/:quoteId
    const quoteMatch = path.match(/^\/api\/quotes\/(\d+)$/);
    if (quoteMatch) {
      const quoteId = quoteMatch[1];
      if (method === 'PUT') {
        const { quoted_price, moq, lead_time_days, status, sample_awb, remarks, is_selected } = await request.json();
        await db.execute({
          sql: `UPDATE item_quotes
                SET quoted_price = ?, moq = ?, lead_time_days = ?, status = ?,
                    sample_awb = ?, remarks = ?, is_selected = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [
            Number(quoted_price) || 0,
            Number(moq) || 0,
            Number(lead_time_days) || 0,
            status,
            sample_awb || '',
            remarks || '',
            is_selected ? 1 : 0,
            quoteId,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: `DELETE FROM item_quotes WHERE id = ?`, args: [quoteId] });
        return jsonResponse({ success: true });
      }
    }

    return jsonResponse({ error: 'API route not found' }, 404);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}