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

// Configure Admin emails for Alex and Jesu Doss here (or via Cloudflare Pages env var ADMIN_EMAILS)
const DEFAULT_ADMIN_EMAILS = [
  'business@glglobal.in',
  'alex@glglobal.in',
];

function isAdminAuthorized(request, env) {
  const cfEmail = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  if (!cfEmail) return false;

  const envAdmins = (env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const allowlist = envAdmins.length > 0 ? envAdmins : DEFAULT_ADMIN_EMAILS;
  return allowlist.includes(cfEmail);
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
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

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
      supplier_code TEXT DEFAULT '',
      company_name TEXT NOT NULL,
      contact_person TEXT,
      role_designation TEXT DEFAULT '',
      phone_whatsapp TEXT,
      email TEXT,
      facility_type TEXT DEFAULT 'Manufacturing',
      city_country TEXT,
      monthly_capacity TEXT DEFAULT '',
      coa_doc_url TEXT DEFAULT '',
      media_folder_url TEXT DEFAULT '',
      facility_photo_data TEXT DEFAULT '',
      qual_kyc_gst INTEGER DEFAULT 0,
      qual_facility_verified INTEGER DEFAULT 0,
      qual_capacity_verified INTEGER DEFAULT 0,
      qual_certs_verified INTEGER DEFAULT 0,
      qual_coa_verified INTEGER DEFAULT 0,
      linked_products_json TEXT DEFAULT '[]',
      supplier_status TEXT DEFAULT 'Under Verification',
      is_archived INTEGER DEFAULT 0,
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
      status TEXT DEFAULT 'Received',
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
      status TEXT DEFAULT 'RFQ Sent',
      sample_awb TEXT DEFAULT '',
      remarks TEXT DEFAULT '',
      is_selected INTEGER DEFAULT 0,
      po_number TEXT DEFAULT '',
      payment_mode TEXT DEFAULT '',
      payment_ref TEXT DEFAULT '',
      qc_status TEXT DEFAULT 'Pending QC',
      bl_number TEXT DEFAULT '',
      shipping_bill_no TEXT DEFAULT '',
      container_no TEXT DEFAULT '',
      etd TEXT DEFAULT '',
      eta TEXT DEFAULT '',
      shipping_docs TEXT DEFAULT '',
      execution_stage TEXT DEFAULT 'PO Issued',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
    );
  `);

  // Safe migrations for existing Turso databases
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN moq_unit TEXT DEFAULT 'KG'`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN po_number TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN payment_mode TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN payment_ref TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN qc_status TEXT DEFAULT 'Pending QC'`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN bl_number TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN shipping_bill_no TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN container_no TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN etd TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN eta TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN shipping_docs TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE item_quotes ADD COLUMN execution_stage TEXT DEFAULT 'PO Issued'`);

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

  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN supplier_code TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN role_designation TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN facility_type TEXT DEFAULT 'Manufacturing'`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN monthly_capacity TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN coa_doc_url TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN media_folder_url TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN facility_photo_data TEXT DEFAULT ''`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN qual_kyc_gst INTEGER DEFAULT 0`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN qual_facility_verified INTEGER DEFAULT 0`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN qual_capacity_verified INTEGER DEFAULT 0`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN qual_certs_verified INTEGER DEFAULT 0`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN qual_coa_verified INTEGER DEFAULT 0`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN linked_products_json TEXT DEFAULT '[]'`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN supplier_status TEXT DEFAULT 'Under Verification'`);
  await safeAlter(db, `ALTER TABLE suppliers ADD COLUMN is_archived INTEGER DEFAULT 0`);

  schemaInitialized = true;
}

function parseLinkedProducts(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
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

  // Enforce server-side Admin restriction on all permanent DELETE requests via Cloudflare Access header
  if (method === 'DELETE' && !isAdminAuthorized(request, env)) {
    return jsonResponse(
      { error: 'Forbidden: Permanent deletion is restricted to Alex and Jesu Doss.' },
      403
    );
  }

  const db = getDB(env);

  try {
    await ensureSchema(db);

    // SETTINGS & USER PASSWORDS (GET, PUT)
    if (path === '/api/settings') {
      if (method === 'GET') {
        const res = await db.execute('SELECT key, value FROM app_settings');
        const map = {};
        for (const row of res.rows) {
          try {
            map[row.key] = JSON.parse(row.value);
          } catch (_) {
            map[row.key] = row.value;
          }
        }
        return jsonResponse({
          users: Array.isArray(map.users) ? map.users : null,
          systemSettings: map.systemSettings && typeof map.systemSettings === 'object' ? map.systemSettings : null,
        });
      }

      if (method === 'PUT') {
        // If Cloudflare Access header is present, ensure caller is an Admin
        const hasCfHeader = Boolean(request.headers.get('Cf-Access-Authenticated-User-Email'));
        if (hasCfHeader && !isAdminAuthorized(request, env)) {
          return jsonResponse(
            { error: 'Forbidden: System settings and user management are restricted to Alex and Jesu Doss.' },
            403
          );
        }

        const { users, systemSettings } = await request.json();
        if (Array.isArray(users)) {
          await db.execute({
            sql: `INSERT INTO app_settings (key, value, updated_at)
                  VALUES ('users', ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
            args: [JSON.stringify(users)],
          });
        }
        if (systemSettings && typeof systemSettings === 'object') {
          await db.execute({
            sql: `INSERT INTO app_settings (key, value, updated_at)
                  VALUES ('systemSettings', ?, CURRENT_TIMESTAMP)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
            args: [JSON.stringify(systemSettings)],
          });
        }
        return jsonResponse({ success: true });
      }
    }

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
      const [buyers, suppliersRes] = await Promise.all([
        db.execute('SELECT * FROM buyers ORDER BY company_name ASC'),
        db.execute('SELECT * FROM suppliers ORDER BY id ASC'),
      ]);
      const suppliers = suppliersRes.rows.map((s, idx) => ({
        ...s,
        supplier_code: s.supplier_code || `GL-SUP-${String(s.id || idx + 1).padStart(4, '0')}`,
        linked_products: parseLinkedProducts(s.linked_products_json),
        is_archived: Number(s.is_archived) || 0,
        qual_kyc_gst: Number(s.qual_kyc_gst) || 0,
        qual_facility_verified: Number(s.qual_facility_verified) || 0,
        qual_capacity_verified: Number(s.qual_capacity_verified) || 0,
        qual_certs_verified: Number(s.qual_certs_verified) || 0,
        qual_coa_verified: Number(s.qual_coa_verified) || 0,
      }));
      return jsonResponse({ buyers: buyers.rows, suppliers });
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
      const {
        supplier_code,
        company_name,
        contact_person,
        role_designation,
        phone_whatsapp,
        email,
        facility_type,
        city_country,
        monthly_capacity,
        coa_doc_url,
        media_folder_url,
        facility_photo_data,
        qual_kyc_gst,
        qual_facility_verified,
        qual_capacity_verified,
        qual_certs_verified,
        qual_coa_verified,
        linked_products,
        supplier_status,
        certifications,
      } = await request.json();

      const cleanLinked = Array.isArray(linked_products) ? linked_products : [];
      const specialtiesText = cleanLinked.map((p) => `${p.product_id ? p.product_id + ' - ' : ''}${p.product_name}`).join(', ');

      const result = await db.execute({
        sql: `INSERT INTO suppliers
              (supplier_code, company_name, contact_person, role_designation, phone_whatsapp, email, facility_type, city_country,
               monthly_capacity, coa_doc_url, media_folder_url, facility_photo_data,
               qual_kyc_gst, qual_facility_verified, qual_capacity_verified, qual_certs_verified, qual_coa_verified,
               linked_products_json, supplier_status, is_archived, specialties, certifications)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING *`,
        args: [
          supplier_code || '',
          company_name,
          contact_person || '',
          role_designation || '',
          phone_whatsapp || '',
          email || '',
          facility_type || 'Manufacturing',
          city_country || '',
          monthly_capacity || '',
          coa_doc_url || '',
          media_folder_url || '',
          facility_photo_data || '',
          qual_kyc_gst ? 1 : 0,
          qual_facility_verified ? 1 : 0,
          qual_capacity_verified ? 1 : 0,
          qual_certs_verified ? 1 : 0,
          qual_coa_verified ? 1 : 0,
          JSON.stringify(cleanLinked),
          supplier_status || 'Under Verification',
          specialtiesText,
          certifications || '',
        ],
      });

      const created = result.rows[0];
      if (!created.supplier_code) {
        const autoCode = `GL-SUP-${String(created.id).padStart(4, '0')}`;
        await db.execute({ sql: 'UPDATE suppliers SET supplier_code = ? WHERE id = ?', args: [autoCode, created.id] });
        created.supplier_code = autoCode;
      }
      return jsonResponse(created);
    }

    // 5. PUT & DELETE /api/suppliers/:id
    const supplierMatch = path.match(/^\/api\/suppliers\/(\d+)$/);
    if (supplierMatch) {
      const supplierId = supplierMatch[1];
      if (method === 'PUT') {
        const body = await request.json();
        if (body.archive_only) {
          await db.execute({
            sql: `UPDATE suppliers SET is_archived = ? WHERE id = ?`,
            args: [body.is_archived ? 1 : 0, supplierId],
          });
          return jsonResponse({ success: true });
        }

        const {
          supplier_code,
          company_name,
          contact_person,
          role_designation,
          phone_whatsapp,
          email,
          facility_type,
          city_country,
          monthly_capacity,
          coa_doc_url,
          media_folder_url,
          facility_photo_data,
          qual_kyc_gst,
          qual_facility_verified,
          qual_capacity_verified,
          qual_certs_verified,
          qual_coa_verified,
          linked_products,
          supplier_status,
          is_archived,
          certifications,
        } = body;

        const cleanLinked = Array.isArray(linked_products) ? linked_products : [];
        const specialtiesText = cleanLinked.map((p) => `${p.product_id ? p.product_id + ' - ' : ''}${p.product_name}`).join(', ');
        const finalCode = supplier_code || `GL-SUP-${String(supplierId).padStart(4, '0')}`;

        await db.execute({
          sql: `UPDATE suppliers
                SET supplier_code = ?, company_name = ?, contact_person = ?, role_designation = ?,
                    phone_whatsapp = ?, email = ?, facility_type = ?, city_country = ?,
                    monthly_capacity = ?, coa_doc_url = ?, media_folder_url = ?, facility_photo_data = ?,
                    qual_kyc_gst = ?, qual_facility_verified = ?, qual_capacity_verified = ?,
                    qual_certs_verified = ?, qual_coa_verified = ?,
                    linked_products_json = ?, supplier_status = ?, is_archived = ?,
                    specialties = ?, certifications = ?
                WHERE id = ?`,
          args: [
            finalCode,
            company_name,
            contact_person || '',
            role_designation || '',
            phone_whatsapp || '',
            email || '',
            facility_type || 'Manufacturing',
            city_country || '',
            monthly_capacity || '',
            coa_doc_url || '',
            media_folder_url || '',
            facility_photo_data || '',
            qual_kyc_gst ? 1 : 0,
            qual_facility_verified ? 1 : 0,
            qual_capacity_verified ? 1 : 0,
            qual_certs_verified ? 1 : 0,
            qual_coa_verified ? 1 : 0,
            JSON.stringify(cleanLinked),
            supplier_status || 'Under Verification',
            is_archived ? 1 : 0,
            specialtiesText,
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
          return jsonResponse({ error: 'Cannot delete supplier: they are assigned to active product quotes. Use Archive instead.' }, 400);
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
          status,
          products,
        } = await request.json();

        if (!destination_country || !String(destination_country).trim()) {
          return jsonResponse({ error: 'Destination Country is required.' }, 400);
        }

        const orderRes = await db.execute({
          sql: `INSERT INTO orders
                (order_code, buyer_id, buyer_contact, enquiry_received_date, enquiry_source, destination_country, currency, incoterms, payment_terms, gl_team, buyer_documents, general_notes, target_delivery_date, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
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
            status || 'Received',
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

    // 7. PUT & DELETE /api/orders/:orderId
    const orderMatch = path.match(/^\/api\/orders\/(\d+)$/);
    if (orderMatch) {
      const orderId = orderMatch[1];
      if (method === 'PUT') {
        const body = await request.json();
        if (body.status !== undefined) {
          await db.execute({
            sql: `UPDATE orders SET status = ? WHERE id = ?`,
            args: [body.status || 'Received', orderId],
          });
        }
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({
          sql: `DELETE FROM item_quotes WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)`,
          args: [orderId],
        });
        await db.execute({ sql: `DELETE FROM order_items WHERE order_id = ?`, args: [orderId] });
        await db.execute({ sql: `DELETE FROM orders WHERE id = ?`, args: [orderId] });
        return jsonResponse({ success: true });
      }
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
        'RFQ / Enquiry Ref', 'Enquiry Status', 'Buyer Company', 'Buyer Contact', 'Buyer Phone',
        'Enquiry Received Date', 'Enquiry Source', 'Destination Country', 'Destination Port',
        'Incoterms', 'Currency', 'Payment Terms', 'GL Team', 'Delivery Deadline',
        'Buyer Documents', 'General Notes', 'Product #', 'Product Name',
        'Specifications', 'Required Qty', 'Unit', 'Buyer Target Price', 'Awarded?',
        'Supplier Company', 'Supplier Contact', 'Supplier Phone/WA', 'Supplier Email',
        'Supplier Location', 'Certifications', 'Supplier Quoted Price', 'Margin %',
        'Est. Total Profit', 'MOQ', 'MOQ Unit', 'Lead Time (Days)', 'Supplier Status',
        'Sample AWB', 'PO Number', 'Execution Stage', 'Payment Mode', 'LC / UTR Ref',
        'QC Status', 'BL / LR Number', 'Shipping Bill #', 'Container / Vehicle #',
        'ETD', 'ETA', 'Shipping Docs', 'Remarks',
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
              order.order_code, order.status, order.buyer_name, buyerContact, order.buyer_phone,
              order.enquiry_received_date, order.enquiry_source, order.destination_country,
              order.destination_port, order.incoterms, order.currency, order.payment_terms,
              order.gl_team, order.target_delivery_date, order.buyer_documents, order.general_notes,
              idx + 1, item.product_name, item.specifications, item.required_qty, item.unit,
              item.buyer_target_price, mode === 'awarded' ? 'PENDING AWARD' : 'NO SUPPLIER',
              '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
              '', '', '', '', '', '', '', '', '', '', '', '',
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
                order.order_code, order.status, order.buyer_name, buyerContact, order.buyer_phone,
                order.enquiry_received_date, order.enquiry_source, order.destination_country,
                order.destination_port, order.incoterms, order.currency, order.payment_terms,
                order.gl_team, order.target_delivery_date, order.buyer_documents, order.general_notes,
                idx + 1, item.product_name, item.specifications, item.required_qty, item.unit,
                item.buyer_target_price, Number(q.is_selected) === 1 ? 'YES - AWARDED' : 'No',
                q.supplier_name, q.supplier_contact, q.supplier_phone, q.supplier_email,
                q.city_country, q.certifications, q.quoted_price, marginPct, totalProfit,
                q.moq, q.moq_unit || item.unit, q.lead_time_days, q.status, q.sample_awb,
                q.po_number, q.execution_stage, q.payment_mode || order.payment_terms, q.payment_ref,
                q.qc_status, q.bl_number, q.shipping_bill_no, q.container_no,
                q.etd, q.eta, q.shipping_docs, q.remarks,
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
          status || 'RFQ Sent',
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
        const {
          quoted_price,
          moq,
          moq_unit,
          lead_time_days,
          status,
          sample_awb,
          remarks,
          is_selected,
          po_number,
          payment_mode,
          payment_ref,
          qc_status,
          bl_number,
          shipping_bill_no,
          container_no,
          etd,
          eta,
          shipping_docs,
          execution_stage,
        } = await request.json();

        await db.execute({
          sql: `UPDATE item_quotes
                SET quoted_price = ?, moq = ?, moq_unit = ?, lead_time_days = ?, status = ?,
                    sample_awb = ?, remarks = ?, is_selected = ?,
                    po_number = ?, payment_mode = ?, payment_ref = ?, qc_status = ?,
                    bl_number = ?, shipping_bill_no = ?, container_no = ?,
                    etd = ?, eta = ?, shipping_docs = ?, execution_stage = ?,
                    updated_at = CURRENT_TIMESTAMP
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
            po_number || '',
            payment_mode || '',
            payment_ref || '',
            qc_status || 'Pending QC',
            bl_number || '',
            shipping_bill_no || '',
            container_no || '',
            etd || '',
            eta || '',
            shipping_docs || '',
            execution_stage || 'PO Issued',
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