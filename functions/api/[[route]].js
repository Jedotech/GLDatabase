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

async function safeAlter(db, sql) {
  try {
    await db.execute(sql);
  } catch (_) {
    // Column already exists
  }
}

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

    CREATE TABLE IF NOT EXISTS gl_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT DEFAULT '',
      product_name TEXT NOT NULL,
      category TEXT DEFAULT '',
      origin TEXT DEFAULT '',
      spec_coa_pdf_name TEXT DEFAULT '',
      spec_coa_pdf_data TEXT DEFAULT '',
      hsn_code TEXT DEFAULT 'Need to update',
      internal_notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL,
      buyer_id INTEGER NOT NULL,
      buyer_contact TEXT DEFAULT '',
      enquiry_received_date TEXT DEFAULT '',
      enquiry_source TEXT DEFAULT 'Email',
      destination_country TEXT DEFAULT '',
      currency TEXT DEFAULT 'USD',
      incoterms TEXT DEFAULT 'FOB',
      payment_terms TEXT DEFAULT 'TBA',
      gl_team TEXT DEFAULT '',
      buyer_documents TEXT DEFAULT '',
      general_notes TEXT DEFAULT '',
      target_delivery_date TEXT,
      status TEXT DEFAULT 'Active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (buyer_id) REFERENCES buyers(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      gl_product_id INTEGER,
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
      moq_unit TEXT DEFAULT 'KG',
      lead_time_days INTEGER DEFAULT 0,
      status TEXT DEFAULT '1 - RFQ Sent',
      sample_awb TEXT DEFAULT '',
      remarks TEXT DEFAULT '',
      is_selected INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );

    CREATE TABLE IF NOT EXISTS buyer_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT NOT NULL,
      buyer_id INTEGER NOT NULL,
      order_id INTEGER,
      currency TEXT DEFAULT 'USD',
      invoice_amount REAL DEFAULT 0,
      amount_received REAL DEFAULT 0,
      due_date TEXT DEFAULT '',
      payment_status TEXT DEFAULT 'Unpaid',
      remarks TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS supplier_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_ref TEXT NOT NULL,
      supplier_id INTEGER NOT NULL,
      order_id INTEGER,
      currency TEXT DEFAULT 'INR',
      total_amount REAL DEFAULT 0,
      amount_paid REAL DEFAULT 0,
      qc_status TEXT DEFAULT 'Pending QC',
      payment_status TEXT DEFAULT 'Pending',
      remarks TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS logistics_shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_ref TEXT NOT NULL,
      order_id INTEGER,
      buyer_id INTEGER,
      origin_port TEXT DEFAULT '',
      destination_port TEXT DEFAULT '',
      incoterms TEXT DEFAULT 'FOB',
      container_awb TEXT DEFAULT '',
      shipping_bill_no TEXT DEFAULT '',
      etd TEXT DEFAULT '',
      eta TEXT DEFAULT '',
      stage TEXT DEFAULT 'Booked',
      remarks TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN moq_unit TEXT DEFAULT 'KG'`);
  await safeAlter(db, `ALTER TABLE orders ADD COLUMN buyer_contact TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE orders ADD COLUMN enquiry_received_date TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE orders ADD COLUMN enquiry_source TEXT DEFAULT 'Email'`);
  await safeAlter(db, `ALTER TABLE orders ADD COLUMN destination_country TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE orders ADD COLUMN payment_terms TEXT DEFAULT 'TBA'`);
  await safeAlter(db, `ALTER TABLE orders ADD COLUMN gl_team TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE orders ADD COLUMN buyer_documents TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE orders ADD COLUMN general_notes TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE order_items ADD COLUMN gl_product_id INTEGER`);
  await safeAlter(db, `ALTER TABLE gl_products ADD COLUMN product_id TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE gl_products ADD COLUMN spec_coa_pdf_name TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE gl_products ADD COLUMN spec_coa_pdf_data TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE gl_products ADD COLUMN internal_notes TEXT DEFAULT ''`);

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

    // 0. GL PRODUCTS MASTER (GET, POST, PUT, DELETE)
    if (path === '/api/gl-products') {
      if (method === 'GET') {
        const res = await db.execute('SELECT * FROM gl_products ORDER BY product_id ASC, id DESC');
        return jsonResponse(res.rows);
      }
      if (method === 'POST') {
        const {
          product_id,
          product_name,
          category,
          origin,
          spec_coa_pdf_name,
          spec_coa_pdf_data,
          hsn_code,
          internal_notes,
        } = await request.json();

        const res = await db.execute({
          sql: `INSERT INTO gl_products
                (product_id, product_name, category, origin, spec_coa_pdf_name, spec_coa_pdf_data, hsn_code, internal_notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          args: [
            product_id || '',
            product_name,
            category || '',
            origin || '',
            spec_coa_pdf_name || '',
            spec_coa_pdf_data || '',
            hsn_code || 'Need to update',
            internal_notes || '',
          ],
        });
        return jsonResponse(res.rows[0]);
      }
    }

    const glProdMatch = path.match(/^\/api\/gl-products\/(\d+)$/);
    if (glProdMatch) {
      const id = glProdMatch[1];
      if (method === 'PUT') {
        const {
          product_id,
          product_name,
          category,
          origin,
          spec_coa_pdf_name,
          spec_coa_pdf_data,
          hsn_code,
          internal_notes,
        } = await request.json();

        await db.execute({
          sql: `UPDATE gl_products
                SET product_id=?, product_name=?, category=?, origin=?,
                    spec_coa_pdf_name=?, spec_coa_pdf_data=?, hsn_code=?, internal_notes=?
                WHERE id=?`,
          args: [
            product_id || '',
            product_name,
            category || '',
            origin || '',
            spec_coa_pdf_name || '',
            spec_coa_pdf_data || '',
            hsn_code || 'Need to update',
            internal_notes || '',
            id,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM gl_products WHERE id = ?', args: [id] });
        return jsonResponse({ success: true });
      }
    }

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
          return jsonResponse({ error: 'Cannot delete buyer: they are linked to existing orders. Delete their orders first.' }, 400);
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
          SELECT o.*, b.company_name AS buyer_name, b.contact_person AS default_buyer_contact,
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
          buyer_contact: order.buyer_contact || order.default_buyer_contact || '',
          items: itemsByOrder[order.id] || [],
        }));

        return jsonResponse(fullOrders);
      }

      if (method === 'POST') {
        const {
          order_code,
          buyer_id,
          buyer_contact,
          enquiry_received_date,
          enquiry_source,
          destination_country,
          currency,
          incoterms,
          payment_terms,
          gl_team,
          buyer_documents,
          general_notes,
          target_delivery_date,
          products,
        } = await request.json();

        if (!destination_country || !String(destination_country).trim()) {
          return jsonResponse({ error: 'Destination Country is required.' }, 400);
        }

        const orderRes = await db.execute({
          sql: `INSERT INTO orders
                (order_code, buyer_id, buyer_contact, enquiry_received_date, enquiry_source, destination_country, currency, incoterms, payment_terms, gl_team, buyer_documents, general_notes, target_delivery_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          args: [
            order_code,
            buyer_id,
            buyer_contact || '',
            enquiry_received_date || '',
            enquiry_source || 'Email',
            String(destination_country).trim(),
            currency || 'USD',
            incoterms || 'FOB',
            payment_terms || 'TBA',
            gl_team || '',
            buyer_documents || '',
            general_notes || '',
            target_delivery_date || '',
          ],
        });
        const orderId = orderRes.rows[0].id;

        if (Array.isArray(products)) {
          for (const p of products) {
            if (!p.product_name || !p.product_name.trim()) continue;
            await db.execute({
              sql: `INSERT INTO order_items (order_id, gl_product_id, product_name, specifications, required_qty, unit, buyer_target_price)
                    VALUES (?, ?, ?, ?, ?, ?, ?)`,
              args: [
                orderId,
                p.gl_product_id ? Number(p.gl_product_id) : null,
                p.product_name.trim(),
                p.specifications || '',
                Number(p.required_qty) || 0,
                p.unit || 'MT',
                Number(p.buyer_target_price) || 0,
              ],
            });
          }
        }
        return jsonResponse({ id: orderId });
      }
    }

    // 7. DELETE /api/orders/:orderId
    const orderDeleteMatch = path.match(/^\/api\/orders\/(\d+)$/);
    if (orderDeleteMatch && method === 'DELETE') {
      const orderId = orderDeleteMatch[1];
      await db.execute({
        sql: `DELETE FROM item_quotes WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
        args: [orderId],
      });
      await db.execute({ sql: `DELETE FROM order_items WHERE order_id = ?`, args: [orderId] });
      await db.execute({ sql: `DELETE FROM orders WHERE id = ?`, args: [orderId] });
      return jsonResponse({ success: true });
    }

    // 8. POST /api/orders/:orderId/items
    const orderItemsMatch = path.match(/^\/api\/orders\/(\d+)\/items$/);
    if (orderItemsMatch && method === 'POST') {
      const orderId = orderItemsMatch[1];
      const { gl_product_id, product_name, specifications, required_qty, unit, buyer_target_price } = await request.json();
      const result = await db.execute({
        sql: `INSERT INTO order_items (order_id, gl_product_id, product_name, specifications, required_qty, unit, buyer_target_price)
              VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [
          orderId,
          gl_product_id ? Number(gl_product_id) : null,
          product_name,
          specifications || '',
          Number(required_qty) || 0,
          unit || 'MT',
          Number(buyer_target_price) || 0,
        ],
      });
      return jsonResponse(result.rows[0]);
    }

    // 9. GET /api/orders/:orderId/export
    const exportMatch = path.match(/^\/api\/orders\/(\d+)\/export$/);
    if (exportMatch && method === 'GET') {
      const orderId = exportMatch[1];
      const mode = url.searchParams.get('mode') === 'awarded' ? 'awarded' : 'all';

      const orderRes = await db.execute({
        sql: `SELECT o.*, b.company_name AS buyer_name, b.contact_person AS default_buyer_contact,
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
      const buyerContact = order.buyer_contact || order.default_buyer_contact || '';

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
        'RFQ / Enquiry Ref', 'Buyer Company', 'Buyer Contact', 'Buyer Phone',
        'Enquiry Received Date', 'Enquiry Source', 'Destination Country', 'Destination Port',
        'Incoterms', 'Currency', 'Payment Terms', 'GL Team', 'Delivery Deadline',
        'Buyer Documents', 'General Notes', 'Product #', 'Product Name',
        'Specifications', 'Required Qty', 'Unit', 'Buyer Target Price', 'Awarded?',
        'Supplier Company', 'Supplier Contact', 'Supplier Phone/WA', 'Supplier Email',
        'Supplier Location', 'Certifications', 'Supplier Quoted Price', 'Margin %',
        'Est. Total Profit', 'MOQ', 'MOQ Unit', 'Lead Time (Days)', 'Sourcing Status', 'Sample AWB', 'Remarks',
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
              order.order_code, order.buyer_name, buyerContact, order.buyer_phone,
              order.enquiry_received_date, order.enquiry_source, order.destination_country,
              order.destination_port, order.incoterms, order.currency, order.payment_terms,
              order.gl_team, order.target_delivery_date, order.buyer_documents, order.general_notes,
              idx + 1, item.product_name, item.specifications, item.required_qty, item.unit,
              item.buyer_target_price, mode === 'awarded' ? 'PENDING AWARD' : 'NO SUPPLIER',
              '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
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
                order.order_code, order.buyer_name, buyerContact, order.buyer_phone,
                order.enquiry_received_date, order.enquiry_source, order.destination_country,
                order.destination_port, order.incoterms, order.currency, order.payment_terms,
                order.gl_team, order.target_delivery_date, order.buyer_documents, order.general_notes,
                idx + 1, item.product_name, item.specifications, item.required_qty, item.unit,
                item.buyer_target_price, Number(q.is_selected) === 1 ? 'YES - AWARDED' : 'No',
                q.supplier_name, q.supplier_contact, q.supplier_phone, q.supplier_email,
                q.city_country, q.certifications, q.quoted_price, marginPct, totalProfit,
                q.moq, q.moq_unit || item.unit, q.lead_time_days, q.status, q.sample_awb, q.remarks,
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

    // 10. PUT & DELETE /api/items/:itemId
    const itemMatch = path.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch) {
      const itemId = itemMatch[1];
      if (method === 'PUT') {
        const { gl_product_id, product_name, specifications, required_qty, unit, buyer_target_price } = await request.json();
        await db.execute({
          sql: `UPDATE order_items
                SET gl_product_id = ?, product_name = ?, specifications = ?, required_qty = ?, unit = ?, buyer_target_price = ?
                WHERE id = ?`,
          args: [
            gl_product_id ? Number(gl_product_id) : null,
            product_name,
            specifications || '',
            Number(required_qty) || 0,
            unit || 'MT',
            Number(buyer_target_price) || 0,
            itemId,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: `DELETE FROM order_items WHERE id = ?`, args: [itemId] });
        return jsonResponse({ success: true });
      }
    }

    // 11. POST /api/items/:itemId/quotes
    const itemQuotesMatch = path.match(/^\/api\/items\/(\d+)\/quotes$/);
    if (itemQuotesMatch && method === 'POST') {
      const itemId = itemQuotesMatch[1];
      const { supplier_id, quoted_price, moq, moq_unit, lead_time_days, status, sample_awb, remarks } = await request.json();
      const result = await db.execute({
        sql: `INSERT INTO item_quotes (order_item_id, supplier_id, quoted_price, moq, moq_unit, lead_time_days, status, sample_awb, remarks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [
          itemId,
          supplier_id,
          Number(quoted_price) || 0,
          Number(moq) || 0,
          moq_unit || 'KG',
          Number(lead_time_days) || 0,
          status || '1 - RFQ Sent',
          sample_awb || '',
          remarks || '',
        ],
      });
      return jsonResponse(result.rows[0]);
    }

    // 12. PUT & DELETE /api/quotes/:quoteId
    const quoteMatch = path.match(/^\/api\/quotes\/(\d+)$/);
    if (quoteMatch) {
      const quoteId = quoteMatch[1];
      if (method === 'PUT') {
        const { quoted_price, moq, moq_unit, lead_time_days, status, sample_awb, remarks, is_selected } = await request.json();
        await db.execute({
          sql: `UPDATE item_quotes
                SET quoted_price = ?, moq = ?, moq_unit = ?, lead_time_days = ?, status = ?,
                    sample_awb = ?, remarks = ?, is_selected = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [
            Number(quoted_price) || 0,
            Number(moq) || 0,
            moq_unit || 'KG',
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

    // PHASE 2 ROUTES
    if (path === '/api/buyer-ledger') {
      if (method === 'GET') {
        const res = await db.execute(`
          SELECT bl.*, b.company_name AS buyer_name, o.order_code
          FROM buyer_ledger bl
          JOIN buyers b ON bl.buyer_id = b.id
          LEFT JOIN orders o ON bl.order_id = o.id
          ORDER BY bl.id DESC
        `);
        return jsonResponse(res.rows);
      }
      if (method === 'POST') {
        const { invoice_no, buyer_id, order_id, currency, invoice_amount, amount_received, due_date, payment_status, remarks } =
          await request.json();
        const res = await db.execute({
          sql: `INSERT INTO buyer_ledger (invoice_no, buyer_id, order_id, currency, invoice_amount, amount_received, due_date, payment_status, remarks)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          args: [
            invoice_no,
            buyer_id,
            order_id ? Number(order_id) : null,
            currency || 'USD',
            Number(invoice_amount) || 0,
            Number(amount_received) || 0,
            due_date || '',
            payment_status || 'Unpaid',
            remarks || '',
          ],
        });
        return jsonResponse(res.rows[0]);
      }
    }

    const buyerLedgerMatch = path.match(/^\/api\/buyer-ledger\/(\d+)$/);
    if (buyerLedgerMatch) {
      const id = buyerLedgerMatch[1];
      if (method === 'PUT') {
        const { invoice_no, buyer_id, order_id, currency, invoice_amount, amount_received, due_date, payment_status, remarks } =
          await request.json();
        await db.execute({
          sql: `UPDATE buyer_ledger
                SET invoice_no=?, buyer_id=?, order_id=?, currency=?, invoice_amount=?, amount_received=?, due_date=?, payment_status=?, remarks=?
                WHERE id=?`,
          args: [
            invoice_no,
            buyer_id,
            order_id ? Number(order_id) : null,
            currency || 'USD',
            Number(invoice_amount) || 0,
            Number(amount_received) || 0,
            due_date || '',
            payment_status || 'Unpaid',
            remarks || '',
            id,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM buyer_ledger WHERE id = ?', args: [id] });
        return jsonResponse({ success: true });
      }
    }

    if (path === '/api/supplier-ledger') {
      if (method === 'GET') {
        const res = await db.execute(`
          SELECT sl.*, s.company_name AS supplier_name, o.order_code
          FROM supplier_ledger sl
          JOIN suppliers s ON sl.supplier_id = s.id
          LEFT JOIN orders o ON sl.order_id = o.id
          ORDER BY sl.id DESC
        `);
        return jsonResponse(res.rows);
      }
      if (method === 'POST') {
        const { po_ref, supplier_id, order_id, currency, total_amount, amount_paid, qc_status, payment_status, remarks } =
          await request.json();
        const res = await db.execute({
          sql: `INSERT INTO supplier_ledger (po_ref, supplier_id, order_id, currency, total_amount, amount_paid, qc_status, payment_status, remarks)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          args: [
            po_ref,
            supplier_id,
            order_id ? Number(order_id) : null,
            currency || 'INR',
            Number(total_amount) || 0,
            Number(amount_paid) || 0,
            qc_status || 'Pending QC',
            payment_status || 'Pending',
            remarks || '',
          ],
        });
        return jsonResponse(res.rows[0]);
      }
    }

    const supplierLedgerMatch = path.match(/^\/api\/supplier-ledger\/(\d+)$/);
    if (supplierLedgerMatch) {
      const id = supplierLedgerMatch[1];
      if (method === 'PUT') {
        const { po_ref, supplier_id, order_id, currency, total_amount, amount_paid, qc_status, payment_status, remarks } =
          await request.json();
        await db.execute({
          sql: `UPDATE supplier_ledger
                SET po_ref=?, supplier_id=?, order_id=?, currency=?, total_amount=?, amount_paid=?, qc_status=?, payment_status=?, remarks=?
                WHERE id=?`,
          args: [
            po_ref,
            supplier_id,
            order_id ? Number(order_id) : null,
            currency || 'INR',
            Number(total_amount) || 0,
            Number(amount_paid) || 0,
            qc_status || 'Pending QC',
            payment_status || 'Pending',
            remarks || '',
            id,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM supplier_ledger WHERE id = ?', args: [id] });
        return jsonResponse({ success: true });
      }
    }

    if (path === '/api/logistics') {
      if (method === 'GET') {
        const res = await db.execute(`
          SELECT ls.*, b.company_name AS buyer_name, o.order_code
          FROM logistics_shipments ls
          LEFT JOIN buyers b ON ls.buyer_id = b.id
          LEFT JOIN orders o ON ls.order_id = o.id
          ORDER BY ls.id DESC
        `);
        return jsonResponse(res.rows);
      }
      if (method === 'POST') {
        const { shipment_ref, order_id, buyer_id, origin_port, destination_port, incoterms, container_awb, shipping_bill_no, etd, eta, stage, remarks } =
          await request.json();
        const res = await db.execute({
          sql: `INSERT INTO logistics_shipments (shipment_ref, order_id, buyer_id, origin_port, destination_port, incoterms, container_awb, shipping_bill_no, etd, eta, stage, remarks)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          args: [
            shipment_ref,
            order_id ? Number(order_id) : null,
            buyer_id ? Number(buyer_id) : null,
            origin_port || '',
            destination_port || '',
            incoterms || 'FOB',
            container_awb || '',
            shipping_bill_no || '',
            etd || '',
            eta || '',
            stage || 'Booked',
            remarks || '',
          ],
        });
        return jsonResponse(res.rows[0]);
      }
    }

    const logisticsMatch = path.match(/^\/api\/logistics\/(\d+)$/);
    if (logisticsMatch) {
      const id = logisticsMatch[1];
      if (method === 'PUT') {
        const { shipment_ref, order_id, buyer_id, origin_port, destination_port, incoterms, container_awb, shipping_bill_no, etd, eta, stage, remarks } =
          await request.json();
        await db.execute({
          sql: `UPDATE logistics_shipments
                SET shipment_ref=?, order_id=?, buyer_id=?, origin_port=?, destination_port=?, incoterms=?,
                    container_awb=?, shipping_bill_no=?, etd=?, eta=?, stage=?, remarks=?
                WHERE id=?`,
          args: [
            shipment_ref,
            order_id ? Number(order_id) : null,
            buyer_id ? Number(buyer_id) : null,
            origin_port || '',
            destination_port || '',
            incoterms || 'FOB',
            container_awb || '',
            shipping_bill_no || '',
            etd || '',
            eta || '',
            stage || 'Booked',
            remarks || '',
            id,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM logistics_shipments WHERE id = ?', args: [id] });
        return jsonResponse({ success: true });
      }
    }

    return jsonResponse({ error: 'API route not found' }, 404);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}