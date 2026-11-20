require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connects to Turso Cloud if env vars exist, otherwise creates a local SQLite file
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:sourcing.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Initialize Database Schema
async function initDB() {
  await db.executeMultiple(`
    PRAGMA foreign_keys = ON;

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
}

// --- MASTER DIRECTORIES: BUYERS & SUPPLIERS ---

app.get('/api/directory', async (req, res) => {
  try {
    const [buyers, suppliers] = await Promise.all([
      db.execute('SELECT * FROM buyers ORDER BY company_name ASC'),
      db.execute('SELECT * FROM suppliers ORDER BY company_name ASC'),
    ]);
    res.json({ buyers: buyers.rows, suppliers: suppliers.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/buyers', async (req, res) => {
  try {
    const { company_name, contact_person, phone_whatsapp, email, destination_port, notes } = req.body;
    const result = await db.execute({
      sql: `INSERT INTO buyers (company_name, contact_person, phone_whatsapp, email, destination_port, notes)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      args: [company_name, contact_person || '', phone_whatsapp || '', email || '', destination_port || '', notes || ''],
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/buyers/:id', async (req, res) => {
  try {
    const { company_name, contact_person, phone_whatsapp, email, destination_port, notes } = req.body;
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
        req.params.id,
      ],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/buyers/:id', async (req, res) => {
  try {
    const check = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM orders WHERE buyer_id = ?', args: [req.params.id] });
    if (Number(check.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete buyer: they are linked to existing orders.' });
    }
    await db.execute({ sql: 'DELETE FROM buyers WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/suppliers', async (req, res) => {
  try {
    const { company_name, contact_person, phone_whatsapp, email, city_country, specialties, certifications } = req.body;
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
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/suppliers/:id', async (req, res) => {
  try {
    const { company_name, contact_person, phone_whatsapp, email, city_country, specialties, certifications } = req.body;
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
        req.params.id,
      ],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/suppliers/:id', async (req, res) => {
  try {
    const check = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM item_quotes WHERE supplier_id = ?', args: [req.params.id] });
    if (Number(check.rows[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete supplier: they are assigned to active product quotes.' });
    }
    await db.execute({ sql: 'DELETE FROM suppliers WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- ORDERS & NESTED HIERARCHY ---

app.get('/api/orders', async (req, res) => {
  try {
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

    res.json(fullOrders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { order_code, buyer_id, currency, incoterms, target_delivery_date, products } = req.body;
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
    res.json({ id: orderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders/:orderId/items', async (req, res) => {
  try {
    const { product_name, specifications, required_qty, unit, buyer_target_price } = req.body;
    const result = await db.execute({
      sql: `INSERT INTO order_items (order_id, product_name, specifications, required_qty, unit, buyer_target_price)
            VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      args: [
        req.params.orderId,
        product_name,
        specifications || '',
        Number(required_qty) || 0,
        unit || 'KG',
        Number(buyer_target_price) || 0,
      ],
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:itemId', async (req, res) => {
  try {
    await db.execute({ sql: `DELETE FROM order_items WHERE id = ?`, args: [req.params.itemId] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CSV / EXCEL EXPORT ENDPOINT ---

function csvCell(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

app.get('/api/orders/:orderId/export', async (req, res) => {
  try {
    const mode = req.query.mode === 'awarded' ? 'awarded' : 'all';
    const orderRes = await db.execute({
      sql: `SELECT o.*, b.company_name AS buyer_name, b.contact_person AS buyer_contact,
                   b.phone_whatsapp AS buyer_phone, b.email AS buyer_email, b.destination_port
            FROM orders o
            JOIN buyers b ON o.buyer_id = b.id
            WHERE o.id = ?`,
      args: [req.params.orderId],
    });

    if (orderRes.rows.length === 0) {
      return res.status(404).send('Order not found');
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
      'Order Code',
      'Buyer Company',
      'Buyer Contact',
      'Buyer Phone',
      'Destination Port',
      'Incoterms',
      'Currency',
      'Delivery Deadline',
      'Product #',
      'Product Name',
      'Specifications',
      'Required Qty',
      'Unit',
      'Buyer Target Price',
      'Awarded?',
      'Supplier Company',
      'Supplier Contact',
      'Supplier Phone/WA',
      'Supplier Email',
      'Supplier Location',
      'Certifications',
      'Supplier Quoted Price',
      'Margin %',
      'Est. Total Profit',
      'MOQ',
      'Lead Time (Days)',
      'Sourcing Status',
      'Sample AWB',
      'Remarks',
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
            order.order_code,
            order.buyer_name,
            order.buyer_contact,
            order.buyer_phone,
            order.destination_port,
            order.incoterms,
            order.currency,
            order.target_delivery_date,
            idx + 1,
            item.product_name,
            item.specifications,
            item.required_qty,
            item.unit,
            item.buyer_target_price,
            mode === 'awarded' ? 'PENDING AWARD' : 'NO SUPPLIER',
            '', '', '', '', '', '', '', '', '', '', '', '', '', '',
          ]
            .map(csvCell)
            .join(',')
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
              order.order_code,
              order.buyer_name,
              order.buyer_contact,
              order.buyer_phone,
              order.destination_port,
              order.incoterms,
              order.currency,
              order.target_delivery_date,
              idx + 1,
              item.product_name,
              item.specifications,
              item.required_qty,
              item.unit,
              item.buyer_target_price,
              Number(q.is_selected) === 1 ? 'YES - AWARDED' : 'No',
              q.supplier_name,
              q.supplier_contact,
              q.supplier_phone,
              q.supplier_email,
              q.city_country,
              q.certifications,
              q.quoted_price,
              marginPct,
              totalProfit,
              q.moq,
              q.lead_time_days,
              q.status,
              q.sample_awb,
              q.remarks,
            ]
              .map(csvCell)
              .join(',')
          );
        }
      }
    });

    const safeCode = order.order_code.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filename = `${safeCode}_${mode === 'awarded' ? 'Awarded_Summary' : 'Full_Sourcing_Tracker'}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + rows.join('\r\n'));
  } catch (err) {
    res.status(500).send('Export error: ' + err.message);
  }
});

// --- SUPPLIER ASSIGNMENT & INLINE QUOTE TRACKING ---

app.post('/api/items/:itemId/quotes', async (req, res) => {
  try {
    const { supplier_id, quoted_price, moq, lead_time_days, status, sample_awb, remarks } = req.body;
    const result = await db.execute({
      sql: `INSERT INTO item_quotes (order_item_id, supplier_id, quoted_price, moq, lead_time_days, status, sample_awb, remarks)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      args: [
        req.params.itemId,
        supplier_id,
        Number(quoted_price) || 0,
        Number(moq) || 0,
        Number(lead_time_days) || 0,
        status || '1 - RFQ Sent',
        sample_awb || '',
        remarks || '',
      ],
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/quotes/:quoteId', async (req, res) => {
  try {
    const { quoted_price, moq, lead_time_days, status, sample_awb, remarks, is_selected } = req.body;
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
        req.params.quoteId,
      ],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/quotes/:quoteId', async (req, res) => {
  try {
    await db.execute({ sql: `DELETE FROM item_quotes WHERE id = ?`, args: [req.params.quoteId] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`GLDatabase Sourcing Tracker running on http://localhost:${PORT}`));
});