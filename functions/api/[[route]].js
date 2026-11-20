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
  return `"${String(val).replace(/"/g, '""')}"`;
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

    -- Products a Buyer Wants + Linked Supplier + Deal Status
    CREATE TABLE IF NOT EXISTS buyer_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      buyer_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      specifications TEXT DEFAULT '',
      required_qty REAL DEFAULT 0,
      unit TEXT DEFAULT 'KG',
      target_price REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      linked_supplier_id INTEGER,
      supplier_quote_price REAL DEFAULT 0,
      status TEXT DEFAULT 'Not Started',
      remarks TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (buyer_id) REFERENCES buyers(id) ON DELETE CASCADE,
      FOREIGN KEY (linked_supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL
    );

    -- Products a Supplier Can Supply (Catalog)
    CREATE TABLE IF NOT EXISTS supplier_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_id INTEGER NOT NULL,
      product_name TEXT NOT NULL,
      specifications TEXT DEFAULT '',
      unit_price REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      moq REAL DEFAULT 0,
      unit TEXT DEFAULT 'KG',
      lead_time_days INTEGER DEFAULT 0,
      status TEXT DEFAULT 'Active',
      remarks TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE CASCADE
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
    return jsonResponse({ error: 'Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN.' }, 500);
  }

  const db = getDB(env);

  try {
    await ensureSchema(db);

    // 1. GET /api/workspace (Full Buyers + Wanted Products + Suppliers + Supplied Catalog)
    if (path === '/api/workspace' && method === 'GET') {
      const [buyersRes, suppliersRes, buyerProdsRes, supplierProdsRes] = await Promise.all([
        db.execute('SELECT * FROM buyers ORDER BY company_name ASC'),
        db.execute('SELECT * FROM suppliers ORDER BY company_name ASC'),
        db.execute(`
          SELECT bp.*, s.company_name AS linked_supplier_name, s.contact_person AS linked_supplier_contact,
                 s.phone_whatsapp AS linked_supplier_phone
          FROM buyer_products bp
          LEFT JOIN suppliers s ON bp.linked_supplier_id = s.id
          ORDER BY bp.id DESC
        `),
        db.execute('SELECT * FROM supplier_products ORDER BY product_name ASC'),
      ]);

      const prodsByBuyer = {};
      for (const bp of buyerProdsRes.rows) {
        if (!prodsByBuyer[bp.buyer_id]) prodsByBuyer[bp.buyer_id] = [];
        prodsByBuyer[bp.buyer_id].push(bp);
      }

      const catalogBySupplier = {};
      for (const sp of supplierProdsRes.rows) {
        if (!catalogBySupplier[sp.supplier_id]) catalogBySupplier[sp.supplier_id] = [];
        catalogBySupplier[sp.supplier_id].push(sp);
      }

      const buyers = buyersRes.rows.map((b) => ({
        ...b,
        wanted_products: prodsByBuyer[b.id] || [],
      }));

      const suppliers = suppliersRes.rows.map((s) => ({
        ...s,
        supplied_products: catalogBySupplier[s.id] || [],
        linked_deals: buyerProdsRes.rows
          .filter((bp) => Number(bp.linked_supplier_id) === Number(s.id))
          .map((bp) => ({
            ...bp,
            buyer_name: buyersRes.rows.find((b) => Number(b.id) === Number(bp.buyer_id))?.company_name || 'Buyer',
          })),
      }));

      return jsonResponse({ buyers, suppliers });
    }

    // 2. BUYERS CRUD
    if (path === '/api/buyers' && method === 'POST') {
      const { company_name, contact_person, phone_whatsapp, email, destination_port, notes } = await request.json();
      const res = await db.execute({
        sql: `INSERT INTO buyers (company_name, contact_person, phone_whatsapp, email, destination_port, notes)
              VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [company_name, contact_person || '', phone_whatsapp || '', email || '', destination_port || '', notes || ''],
      });
      return jsonResponse(res.rows[0]);
    }

    const buyerMatch = path.match(/^\/api\/buyers\/(\d+)$/);
    if (buyerMatch) {
      const id = buyerMatch[1];
      if (method === 'PUT') {
        const { company_name, contact_person, phone_whatsapp, email, destination_port, notes } = await request.json();
        await db.execute({
          sql: `UPDATE buyers SET company_name=?, contact_person=?, phone_whatsapp=?, email=?, destination_port=?, notes=? WHERE id=?`,
          args: [company_name, contact_person || '', phone_whatsapp || '', email || '', destination_port || '', notes || '', id],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM buyers WHERE id = ?', args: [id] });
        return jsonResponse({ success: true });
      }
    }

    // 3. SUPPLIERS CRUD
    if (path === '/api/suppliers' && method === 'POST') {
      const { company_name, contact_person, phone_whatsapp, email, city_country, specialties, certifications } = await request.json();
      const res = await db.execute({
        sql: `INSERT INTO suppliers (company_name, contact_person, phone_whatsapp, email, city_country, specialties, certifications)
              VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [company_name, contact_person || '', phone_whatsapp || '', email || '', city_country || '', specialties || '', certifications || ''],
      });
      return jsonResponse(res.rows[0]);
    }

    const supplierMatch = path.match(/^\/api\/suppliers\/(\d+)$/);
    if (supplierMatch) {
      const id = supplierMatch[1];
      if (method === 'PUT') {
        const { company_name, contact_person, phone_whatsapp, email, city_country, specialties, certifications } = await request.json();
        await db.execute({
          sql: `UPDATE suppliers SET company_name=?, contact_person=?, phone_whatsapp=?, email=?, city_country=?, specialties=?, certifications=? WHERE id=?`,
          args: [company_name, contact_person || '', phone_whatsapp || '', email || '', city_country || '', specialties || '', certifications || '', id],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM suppliers WHERE id = ?', args: [id] });
        return jsonResponse({ success: true });
      }
    }

    // 4. BUYER WANTED PRODUCTS & SUPPLIER LINKING
    if (path === '/api/buyer-products' && method === 'POST') {
      const { buyer_id, product_name, specifications, required_qty, unit, target_price, currency, linked_supplier_id, supplier_quote_price, status, remarks } =
        await request.json();
      const res = await db.execute({
        sql: `INSERT INTO buyer_products (buyer_id, product_name, specifications, required_qty, unit, target_price, currency, linked_supplier_id, supplier_quote_price, status, remarks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [
          buyer_id,
          product_name,
          specifications || '',
          Number(required_qty) || 0,
          unit || 'KG',
          Number(target_price) || 0,
          currency || 'USD',
          linked_supplier_id ? Number(linked_supplier_id) : null,
          Number(supplier_quote_price) || 0,
          status || 'Not Started',
          remarks || '',
        ],
      });
      return jsonResponse(res.rows[0]);
    }

    const bpMatch = path.match(/^\/api\/buyer-products\/(\d+)$/);
    if (bpMatch) {
      const id = bpMatch[1];
      if (method === 'PUT') {
        const { product_name, specifications, required_qty, unit, target_price, currency, linked_supplier_id, supplier_quote_price, status, remarks } =
          await request.json();
        await db.execute({
          sql: `UPDATE buyer_products
                SET product_name=?, specifications=?, required_qty=?, unit=?, target_price=?, currency=?,
                    linked_supplier_id=?, supplier_quote_price=?, status=?, remarks=?, updated_at=CURRENT_TIMESTAMP
                WHERE id=?`,
          args: [
            product_name,
            specifications || '',
            Number(required_qty) || 0,
            unit || 'KG',
            Number(target_price) || 0,
            currency || 'USD',
            linked_supplier_id ? Number(linked_supplier_id) : null,
            Number(supplier_quote_price) || 0,
            status || 'Not Started',
            remarks || '',
            id,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM buyer_products WHERE id = ?', args: [id] });
        return jsonResponse({ success: true });
      }
    }

    // 5. SUPPLIER CATALOG PRODUCTS
    if (path === '/api/supplier-products' && method === 'POST') {
      const { supplier_id, product_name, specifications, unit_price, currency, moq, unit, lead_time_days, status, remarks } =
        await request.json();
      const res = await db.execute({
        sql: `INSERT INTO supplier_products (supplier_id, product_name, specifications, unit_price, currency, moq, unit, lead_time_days, status, remarks)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        args: [
          supplier_id,
          product_name,
          specifications || '',
          Number(unit_price) || 0,
          currency || 'USD',
          Number(moq) || 0,
          unit || 'KG',
          Number(lead_time_days) || 0,
          status || 'Active',
          remarks || '',
        ],
      });
      return jsonResponse(res.rows[0]);
    }

    const spMatch = path.match(/^\/api\/supplier-products\/(\d+)$/);
    if (spMatch) {
      const id = spMatch[1];
      if (method === 'PUT') {
        const { product_name, specifications, unit_price, currency, moq, unit, lead_time_days, status, remarks } =
          await request.json();
        await db.execute({
          sql: `UPDATE supplier_products
                SET product_name=?, specifications=?, unit_price=?, currency=?, moq=?, unit=?, lead_time_days=?, status=?, remarks=?
                WHERE id=?`,
          args: [
            product_name,
            specifications || '',
            Number(unit_price) || 0,
            currency || 'USD',
            Number(moq) || 0,
            unit || 'KG',
            Number(lead_time_days) || 0,
            status || 'Active',
            remarks || '',
            id,
          ],
        });
        return jsonResponse({ success: true });
      }
      if (method === 'DELETE') {
        await db.execute({ sql: 'DELETE FROM supplier_products WHERE id = ?', args: [id] });
        return jsonResponse({ success: true });
      }
    }

    // 6. EXPORT ALL DEALS CSV
    if (path === '/api/export' && method === 'GET') {
      const res = await db.execute(`
        SELECT b.company_name AS buyer_name, b.contact_person AS buyer_contact, b.phone_whatsapp AS buyer_phone, b.destination_port,
               bp.product_name, bp.specifications, bp.required_qty, bp.unit, bp.target_price, bp.currency,
               bp.status, bp.supplier_quote_price, bp.remarks,
               s.company_name AS supplier_name, s.contact_person AS supplier_contact, s.phone_whatsapp AS supplier_phone, s.city_country
        FROM buyer_products bp
        JOIN buyers b ON bp.buyer_id = b.id
        LEFT JOIN suppliers s ON bp.linked_supplier_id = s.id
        ORDER BY b.company_name ASC, bp.id DESC
      `);

      const headers = [
        'Status', 'Buyer Company', 'Buyer Contact', 'Buyer Phone', 'Destination Port',
        'Wanted Product', 'Specifications', 'Qty', 'Unit', 'Currency', 'Buyer Target Price',
        'Linked Supplier', 'Supplier Contact', 'Supplier Phone', 'Supplier Location',
        'Supplier Quote Price', 'Margin %', 'Remarks',
      ];
      const rows = [headers.map(csvCell).join(',')];

      for (const r of res.rows) {
        const target = Number(r.target_price) || 0;
        const quote = Number(r.supplier_quote_price) || 0;
        const margin = target > 0 && quote > 0 ? (((target - quote) / target) * 100).toFixed(1) + '%' : '';
        rows.push(
          [
            r.status, r.buyer_name, r.buyer_contact, r.buyer_phone, r.destination_port,
            r.product_name, r.specifications, r.required_qty, r.unit, r.currency, r.target_price,
            r.supplier_name || 'Unlinked', r.supplier_contact || '', r.supplier_phone || '', r.city_country || '',
            r.supplier_quote_price || '', margin, r.remarks,
          ].map(csvCell).join(',')
        );
      }

      return new Response('\uFEFF' + rows.join('\r\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="GLDatabase_Sourcing_Matrix.csv"',
        },
      });
    }

    return jsonResponse({ error: 'API route not found' }, 404);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}