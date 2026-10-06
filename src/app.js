
const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const session = require('express-session');
const Stripe = require('stripe');
const MarkdownIt = require('markdown-it');
    
const isProduction = process.env.NODE_ENV === 'production';
const app = express();

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(
    process.env.SUPABASE_URL,
    supabaseKey,
    { realtime: { transport: WebSocket } } // Node < 22 lacks a native WebSocket the realtime client can use
);
const supabaseAuthKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAuth = supabaseAuthKey
    ? createClient(process.env.SUPABASE_URL, supabaseAuthKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
            detectSessionInUrl: false
        }
    })
    : null;

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
const markdownRenderer = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true
});
const markdownPagesDirectory = path.join(__dirname, '../content/pages');

const SHIPPING_START = Number(process.env.SHIPPING_START || 6);
const SHIPPING_ADD = Number(process.env.SHIPPING_ADD || 2);
const SHIPPING_MAX = Number(process.env.SHIPPING_MAX || 12);

const majorCategories = require('../public/major_category.json');
const minorCategories = require('../public/minor_category.json');

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Finds the JSON key whose slug matches the given query param value
const findCategoryKey = (categories, slug) =>
    Object.keys(categories).find(key => slugify(key) === slug);

const COLOR_OPTIONS = [
    'Beige',
    'Black',
    'Blue',
    'Brown',
    'Clear',
    'Gold',
    'Gray',
    'Green',
    'Ivory',
    'Multicolor',
    'Orange',
    'Pink',
    'Purple',
    'Red',
    'Silver',
    'White',
    'Yellow'
];

const COLOR_HEX_MAP = {
    Beige: '#d5c0a5',
    Black: '#1e1e1f',
    Blue: '#5f7db3',
    Brown: '#8a5d42',
    Clear: '#dfe6ee',
    Gold: '#d2a73d',
    Gray: '#8a8d92',
    Green: '#5f8f62',
    Ivory: '#f3eee5',
    Multicolor: '#d799b6',
    Orange: '#dd8a4a',
    Pink: '#d97ea5',
    Purple: '#7856b7',
    Red: '#b64238',
    Silver: '#bcc3cc',
    White: '#ffffff',
    Yellow: '#d8bf52'
};

const COLOR_ALIASES = {
    beige: 'Beige',
    black: 'Black',
    blue: 'Blue',
    brown: 'Brown',
    clear: 'Clear',
    gold: 'Gold',
    gray: 'Gray',
    grey: 'Gray',
    green: 'Green',
    ivory: 'Ivory',
    multicolor: 'Multicolor',
    'multi-color': 'Multicolor',
    orange: 'Orange',
    pink: 'Pink',
    purple: 'Purple',
    red: 'Red',
    silver: 'Silver',
    white: 'White',
    yellow: 'Yellow',
    tan: 'Beige',
    khaki: 'Beige',
    cream: 'Ivory',
    creamwhite: 'Ivory',
    offwhite: 'White',
    'off-white': 'White',
    turquoise: 'Blue',
    teal: 'Blue',
    navy: 'Blue',
    maroon: 'Red',
    rose: 'Pink',
    lilac: 'Purple',
    olive: 'Green',
    'light green': 'Green',
    'dark green': 'Green',
    'light blue': 'Blue',
    'dark blue': 'Blue',
    'light pink': 'Pink',
    'hot pink': 'Pink',
    'light gray': 'Gray',
    'dark gray': 'Gray',
    'light brown': 'Brown',
    'dark brown': 'Brown'
};

const normalizeColorName = (value) => {
    if (typeof value !== 'string') {
        return null;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }

    const lower = trimmed.toLowerCase();

    if (COLOR_ALIASES[lower]) {
        return COLOR_ALIASES[lower];
    }

    const directMatch = COLOR_OPTIONS.find(color =>
        lower === color.toLowerCase() ||
        lower.includes(color.toLowerCase()) ||
        color.toLowerCase().includes(lower)
    );

    return directMatch || null;
};

const extractProductColors = (product) => {
    const rawAspects = product && product.aspects;

    if (!rawAspects) {
        return [];
    }

    let aspects = rawAspects;

    if (typeof aspects === 'string') {
        try {
            aspects = JSON.parse(aspects);
        } catch (error) {
            return [];
        }
    }

    if (!aspects || typeof aspects !== 'object') {
        return [];
    }

    const colorEntry = aspects['aspect-color'] ||
        aspects.aspect_color ||
        Object.values(aspects).find(entry => {
            if (!entry || typeof entry !== 'object') {
                return false;
            }
            const label = typeof entry.label === 'string' ? entry.label.toLowerCase() : '';
            return label === 'color';
        });

    if (!colorEntry) {
        return [];
    }

    const rawValue = typeof colorEntry.value === 'string'
        ? colorEntry.value
        : String(colorEntry.value ?? '');

    if (!rawValue.trim()) {
        return [];
    }

    const parts = rawValue
        .split(/\s*(?:\/|,|&|\band\b)\s*/i)
        .map(part => part.trim())
        .filter(Boolean);

    const colors = [];

    parts.forEach(part => {
        const normalized = normalizeColorName(part);
        if (normalized && !colors.includes(normalized)) {
            colors.push(normalized);
        }
    });

    return colors;
};

const buildColorCounts = (products) => {
    const counts = {};

    products.forEach(product => {
        extractProductColors(product).forEach(color => {
            counts[color] = (counts[color] || 0) + 1;
        });
    });

    return COLOR_OPTIONS
        .map(color => ({
            label: color,
            hex: COLOR_HEX_MAP[color],
            count: counts[color] || 0
        }))
        .filter(option => option.count > 0);
};

const getProductAspects = (product) => {
    const rawAspects = product && product.aspects;

    if (!rawAspects) {
        return {};
    }

    if (typeof rawAspects === 'string') {
        try {
            return JSON.parse(rawAspects) || {};
        } catch (error) {
            return {};
        }
    }

    return rawAspects && typeof rawAspects === 'object' ? rawAspects : {};
};

const normalizeFacetKey = (value) => String(value || '')
    .toLowerCase()
    .replace(/^aspect-/, '')
    .replace(/[_-]+/g, ' ')
    .trim();

const getAspectValue = (product, aspectKeys) => {
    const aspects = getProductAspects(product);
    if (!aspects || typeof aspects !== 'object') {
        return '';
    }

    for (const key of aspectKeys) {
        const entry = aspects[key];
        if (entry && typeof entry === 'object' && typeof entry.value !== 'undefined') {
            return String(entry.value).trim();
        }
    }

    const normalizedTargets = new Set(aspectKeys.map(normalizeFacetKey));

    const matches = Object.values(aspects).filter(entry => {
        if (!entry || typeof entry !== 'object') {
            return false;
        }

        const label = typeof entry.label === 'string' ? entry.label.toLowerCase().trim() : '';
        return normalizedTargets.has(label);
    });

    if (matches.length) {
        return String(matches[0].value ?? '').trim();
    }

    return '';
};

const normalizeFilterValue = (value) => {
    if (typeof value !== 'string') {
        return '';
    }

    return value.trim();
};

const extractProductBrand = (product) => {
    const value = normalizeFilterValue(getAspectValue(product, ['aspect-brand', 'brand', 'aspect_brand']));
    return value ? [value] : [];
};

const extractProductSize = (product) => {
    const value = normalizeFilterValue(getAspectValue(product, ['aspect-size', 'size', 'aspect_size']));
    return value ? [value] : [];
};

const buildFacetCounts = (products, extractor) => {
    const counts = {};

    products.forEach(product => {
        const values = extractor(product);

        values.forEach(value => {
            if (!value) {
                return;
            }

            counts[value] = (counts[value] || 0) + 1;
        });
    });

    return Object.entries(counts)
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => a.label.localeCompare(b.label));
};

const NEW_ARRIVALS_LIMIT = 20;

const getSessionCart = (req) => {
    if (!Array.isArray(req.session.cart)) {
        req.session.cart = [];
    }

    return req.session.cart;
};

const cartHasSku = (req, sku) => getSessionCart(req).includes(sku);

const addSkuToCart = (req, sku) => {
    const cart = getSessionCart(req);

    if (!cart.includes(sku)) {
        cart.push(sku);
    }

    return cart;
};

const removeSkuFromCart = (req, sku) => {
    req.session.cart = getSessionCart(req).filter(item => item !== sku);
    return req.session.cart;
};

const toggleSkuInCart = (req, sku) => {
    if (cartHasSku(req, sku)) {
        return removeSkuFromCart(req, sku);
    }

    return addSkuToCart(req, sku);
};

const getBaseUrl = (req) => {
    const protocol = isProduction ? 'https' : (req.get('x-forwarded-proto') || req.protocol || 'http');
    return `${protocol}://${req.get('host')}`;
};

const toAbsoluteUrl = (req, maybePath) => {
    if (!maybePath) {
        return null;
    }

    try {
        return new URL(maybePath, getBaseUrl(req)).toString();
    } catch (error) {
        return null;
    }
};

const calculateShipping = (itemCount) => {
    if (!Number.isFinite(itemCount) || itemCount <= 0) {
        return 0;
    }

    const start = Number.isFinite(SHIPPING_START) ? SHIPPING_START : 6;
    const add = Number.isFinite(SHIPPING_ADD) ? SHIPPING_ADD : 2;
    const cap = Number.isFinite(SHIPPING_MAX) ? SHIPPING_MAX : 12;

    const shipping = start + (Math.max(1, itemCount) - 1) * add;
    return Math.max(0, Math.min(shipping, cap));
};

const loadCartData = async (req) => {
    const cartSkus = getSessionCart(req);

    if (!cartSkus.length) {
        return {
            cartSkus,
            cartItems: [],
            subtotal: 0,
            shipping: 0,
            tax: 0,
            total: 0,
            cartCount: 0
        };
    }

    const { data: listings, error: listingError } = await supabase
        .from('listing')
        .select(`
            title,
            description,
            price,
            sku,
            category_id,
            created_at,
            aspects
        `)
        .in('sku', cartSkus)
        .eq('state', 1);

    if (listingError) {
        throw listingError;
    }

    const { data: images, error: imageError } = await supabase
        .from('listing_image')
        .select(`
            id,
            sku,
            image_url
        `)
        .in('sku', cartSkus)
        .order('id', { ascending: true });

    if (imageError) {
        throw imageError;
    }

    const cartItems = cartSkus
        .map(sku => {
            const listing = (listings || []).find(item => item.sku === sku);

            if (!listing) {
                return null;
            }

            return {
                ...listing,
                images: (images || []).filter(image => image.sku === sku)
            };
        })
        .filter(Boolean);

    const subtotal = cartItems.reduce((sum, item) => sum + Number(item.price || 0), 0);
    const shipping = calculateShipping(cartItems.length);
    const tax = 0;
    const total = subtotal + shipping;

    return {
        cartSkus,
        cartItems,
        subtotal,
        shipping,
        tax,
        total,
        cartCount: cartItems.length
    };
};

const buildStripeLineItems = (req, cartItems) => cartItems.map(item => {
    const unitAmount = Math.round(Number(item.price || 0) * 100);
    const firstImage = item.images && item.images.length ? item.images[0].image_url : null;
    const absoluteImage = toAbsoluteUrl(req, firstImage);

    const productData = {
        name: item.title,
        description: item.description || undefined,
        metadata: {
            sku: String(item.sku || '')
        }
    };

    if (absoluteImage) {
        productData.images = [absoluteImage];
    }

    return {
        quantity: 1,
        price_data: {
            currency: 'usd',
            product_data: productData,
            unit_amount: unitAmount
        }
    };
});

const persistSessionCart = (req, sessionId, nextCart) => new Promise((resolve, reject) => {
    if (!req.sessionStore || !sessionId) {
        resolve(false);
        return;
    }

    req.sessionStore.get(sessionId, (getError, sessionData) => {
        if (getError) {
            reject(getError);
            return;
        }

        if (!sessionData) {
            resolve(false);
            return;
        }

        sessionData.cart = nextCart;

        req.sessionStore.set(sessionId, sessionData, (setError) => {
            if (setError) {
                reject(setError);
                return;
            }

            resolve(true);
        });
    });
});

const centsToMoney = (valueInCents) => Number((Number(valueInCents || 0) / 100).toFixed(2));

const parseSkuList = (value) => String(value || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());

const getPurchasedSkusFromSession = (checkoutSession) => {
    const metadataSkus = parseSkuList(checkoutSession?.metadata?.cart_skus);

    const lineItemSkus = ((checkoutSession?.line_items?.data) || [])
        .map((lineItem) => {
            if (!lineItem || typeof lineItem !== 'object') {
                return '';
            }

            const product = lineItem.price && typeof lineItem.price === 'object'
                ? lineItem.price.product
                : null;

            if (!product || typeof product !== 'object') {
                return '';
            }

            return String((product.metadata && product.metadata.sku) || '').trim();
        })
        .filter(Boolean);

    return [...new Set([...metadataSkus, ...lineItemSkus])];
};

const saveCompletedOrder = async ({ checkoutSession, purchasedSkus }) => {
    const existingOrderQuery = await supabase
        .from('order_info')
        .select('id')
        .eq('stripe_session_id', checkoutSession.id)
        .maybeSingle();

    if (existingOrderQuery.error) {
        throw existingOrderQuery.error;
    }

    let orderId = existingOrderQuery.data ? existingOrderQuery.data.id : null;

    if (!orderId) {
        const shippingDetails = checkoutSession.shipping_details || {};
        const customerDetails = checkoutSession.customer_details || {};
        const shippingAddress = shippingDetails.address || customerDetails.address || {};

        const customerName = String(shippingDetails.name || customerDetails.name || '').trim();
        const customerEmail = String(customerDetails.email || checkoutSession.customer_email || '').trim();
        const shippingLine1 = String(shippingAddress.line1 || '').trim();
        const shippingCity = String(shippingAddress.city || '').trim();
        const shippingState = String(shippingAddress.state || '').trim();
        const shippingPostalCode = String(shippingAddress.postal_code || '').trim();
        const shippingCountry = String(shippingAddress.country || 'US').trim();

        if (!customerName || !customerEmail || !shippingLine1 || !shippingCity || !shippingState || !shippingPostalCode) {
            throw new Error('Missing required customer/shipping fields from Stripe session.');
        }

        const metadataUserId = String(checkoutSession?.metadata?.user_id || '').trim();

        const orderPayload = {
            user_id: isUuid(metadataUserId) ? metadataUserId : null,
            stripe_session_id: checkoutSession.id,
            stripe_payment_intent_id: typeof checkoutSession.payment_intent === 'string' ? checkoutSession.payment_intent : null,
            status: 'paid',
            customer_name: customerName,
            customer_email: customerEmail,
            customer_phone: customerDetails.phone || null,
            shipping_address_line1: shippingLine1,
            shipping_address_line2: shippingAddress.line2 || null,
            shipping_city: shippingCity,
            shipping_state: shippingState,
            shipping_postal_code: shippingPostalCode,
            shipping_country: shippingCountry,
            subtotal: centsToMoney(checkoutSession.amount_subtotal),
            shipping_amount: centsToMoney(checkoutSession.total_details && checkoutSession.total_details.amount_shipping),
            tax_amount: centsToMoney(checkoutSession.total_details && checkoutSession.total_details.amount_tax),
            total_amount: centsToMoney(checkoutSession.amount_total),
            paid_at: new Date().toISOString()
        };

        const insertedOrder = await supabase
            .from('order_info')
            .insert(orderPayload)
            .select('id')
            .single();

        if (insertedOrder.error) {
            throw insertedOrder.error;
        }

        orderId = insertedOrder.data.id;
    }

    if (purchasedSkus.length) {
        const itemRows = purchasedSkus.map((sku) => ({
            order_info_id: orderId,
            sku
        }));

        const itemInsert = await supabase
            .from('order_info_item')
            .upsert(itemRows, {
                onConflict: 'order_info_id,sku',
                ignoreDuplicates: true
            });

        if (itemInsert.error) {
            throw itemInsert.error;
        }
    }

    return orderId;
};

const archivePurchasedListings = async (purchasedSkus) => {
    if (!purchasedSkus.length) {
        return;
    }

    const hideSold = await supabase
        .from('listing')
        .update({ state: 0 })
        .in('sku', purchasedSkus);

    if (hideSold.error) {
        throw hideSold.error;
    }
};

const wantsJsonResponse = (req) => String(req.get('accept') || '').includes('application/json');

const sanitizeReturnTo = (value, fallback = '/account') => {
    const returnTo = String(value || '').trim();

    if (!returnTo) {
        return fallback;
    }

    if (!returnTo.startsWith('/') || returnTo.startsWith('//')) {
        return fallback;
    }

    return returnTo;
};

const buildDisplayNameFromUser = (user, fallbackEmail = '') => {
    const metadata = user && typeof user.user_metadata === 'object' ? user.user_metadata : {};
    const metadataName = String(metadata.display_name || metadata.full_name || '').trim();

    if (metadataName) {
        return metadataName;
    }

    const emailPrefix = String(fallbackEmail || '').split('@')[0];
    return emailPrefix || 'Account';
};

const buildSessionUserFromSupabaseUser = (user, fallbackEmail = '') => {
    const email = String((user && user.email) || fallbackEmail || '').trim().toLowerCase();

    return {
        id: String((user && user.id) || '').trim(),
        email,
        displayName: buildDisplayNameFromUser(user, email)
    };
};

const getAuthErrorMessage = (error, fallback) => {
    const rawMessage = String((error && error.message) || '').toLowerCase();

    if (!rawMessage) {
        return fallback;
    }

    if (rawMessage.includes('invalid login credentials')) {
        return 'Invalid email or password.';
    }

    if (rawMessage.includes('email not confirmed')) {
        return 'Please confirm your email before signing in.';
    }

    if (rawMessage.includes('user already registered')) {
        return 'An account with this email already exists. Sign in instead.';
    }

    if (rawMessage.includes('signups not allowed')) {
        return 'Signups are currently disabled.';
    }

    return fallback;
};

const sanitizePageSlug = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');

const markdownToHtml = (markdown) => markdownRenderer.render(String(markdown || ''));

const extractMarkdownTitle = (markdown, fallbackTitle) => {
    const match = String(markdown || '').match(/^#\s+(.+)$/m);

    if (match && match[1]) {
        return match[1].trim();
    }

    return fallbackTitle;
};

const loadMarkdownPage = async (slug) => {
    const pageSlug = sanitizePageSlug(slug);

    if (!pageSlug) {
        return null;
    }

    const filePath = path.join(markdownPagesDirectory, `${pageSlug}.md`);

    try {
        const markdown = await fs.readFile(filePath, 'utf8');

        return {
            slug: pageSlug,
            filePath,
            markdown,
            title: extractMarkdownTitle(markdown, pageSlug.replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase()))
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
};

const renderMarkdownPage = (res, {
    title,
    markdown,
    description = '',
    backLinkHref = '/shop',
    backLinkLabel = 'Back to Shop',
    currentPage = ''
}) => {
    return res.render('markdown-page', {
        currentPage,
        pageTitle: title,
        pageDescription: description,
        contentHtml: markdownToHtml(markdown),
        backLinkHref,
        backLinkLabel
    });
};

const normalizeContactField = (value) => String(value || '').trim();

const buildContactMessageBody = ({ name, email, message, user }) => {
    const lines = [];
    const cleanName = normalizeContactField(name);
    const cleanEmail = normalizeContactField(email);
    const cleanMessage = normalizeContactField(message);

    if (cleanName) {
        lines.push(`Name: ${cleanName}`);
    }

    if (cleanEmail) {
        lines.push(`Email: ${cleanEmail}`);
    }

    if (user && user.id) {
        lines.push(`User ID: ${user.id}`);
    }

    lines.push('');
    lines.push(cleanMessage);

    return lines.join('\n').trim();
};

const renderContactPage = (res, {
    currentUser,
    formData,
    formError = null,
    formSuccess = null,
    statusCode = 200
}) => {
    return res.status(statusCode).render('contact', {
        currentPage: '',
        cartCount: typeof formData?.cartCount !== 'undefined' ? formData.cartCount : 0,
        currentUser,
        formData,
        formError,
        formSuccess
    });
};

const loadListingSnapshotsBySkus = async (skus) => {
    const uniqueSkus = [...new Set((skus || []).map(sku => String(sku || '').trim()).filter(Boolean))];

    if (!uniqueSkus.length) {
        return {
            listingBySku: new Map(),
            firstImageBySku: new Map()
        };
    }

    const [listingQuery, imageQuery] = await Promise.all([
        supabase
            .from('listing')
            .select('sku,title,price')
            .in('sku', uniqueSkus),
        supabase
            .from('listing_image')
            .select('id,sku,image_url')
            .in('sku', uniqueSkus)
            .order('id', { ascending: true })
    ]);

    if (listingQuery.error) {
        throw listingQuery.error;
    }

    if (imageQuery.error) {
        throw imageQuery.error;
    }

    const listingBySku = new Map();
    (listingQuery.data || []).forEach((listing) => {
        if (!listing || !listing.sku) {
            return;
        }

        listingBySku.set(listing.sku, listing);
    });

    const firstImageBySku = new Map();
    (imageQuery.data || []).forEach((imageRow) => {
        const sku = imageRow && imageRow.sku ? imageRow.sku : '';
        if (!sku || firstImageBySku.has(sku)) {
            return;
        }

        firstImageBySku.set(sku, imageRow.image_url || null);
    });

    return {
        listingBySku,
        firstImageBySku
    };
};

const enrichOrderItems = (orderItemRows, listingBySku, firstImageBySku) =>
    (orderItemRows || []).map((itemRow) => {
        const sku = String((itemRow && itemRow.sku) || '').trim();
        const listing = listingBySku.get(sku) || null;
        const fallbackTitle = sku ? `SKU ${sku}` : 'Vintage Item';

        return {
            sku,
            title: listing && listing.title ? listing.title : fallbackTitle,
            price: listing && typeof listing.price !== 'undefined' ? Number(listing.price || 0) : null,
            imageUrl: firstImageBySku.get(sku) || null
        };
    });

const loadOrderHistoryForUser = async (userId) => {
    const orderQuery = await supabase
        .from('order_info')
        .select(`
            id,
            status,
            customer_name,
            subtotal,
            shipping_amount,
            tax_amount,
            total_amount,
            shipping_city,
            shipping_state,
            shipping_country,
            created_at,
            paid_at,
            shipped_at,
            delivered_at,
            cancelled_at
        `)
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

    if (orderQuery.error) {
        throw orderQuery.error;
    }

    const orders = orderQuery.data || [];

    if (!orders.length) {
        return [];
    }

    const orderIds = orders.map(order => order.id);

    const orderItemQuery = await supabase
        .from('order_info_item')
        .select('order_info_id,sku')
        .in('order_info_id', orderIds);

    if (orderItemQuery.error) {
        throw orderItemQuery.error;
    }

    const orderItemRows = orderItemQuery.data || [];
    const skus = orderItemRows.map(item => item.sku);
    const { listingBySku, firstImageBySku } = await loadListingSnapshotsBySkus(skus);

    const orderItemsByOrderId = new Map();
    orderItemRows.forEach((itemRow) => {
        const key = itemRow.order_info_id;
        if (!orderItemsByOrderId.has(key)) {
            orderItemsByOrderId.set(key, []);
        }
        orderItemsByOrderId.get(key).push(itemRow);
    });

    return orders.map((order) => {
        const rawItems = orderItemsByOrderId.get(order.id) || [];
        const items = enrichOrderItems(rawItems, listingBySku, firstImageBySku);

        return {
            ...order,
            itemCount: items.length,
            items,
            previewItems: items.slice(0, 4)
        };
    });
};

const sendCartResponse = (req, res, payload) => {
    if (wantsJsonResponse(req)) {
        return res.json(payload);
    }

    const fallbackUrl = req.get('referer') || '/shop';
    return res.redirect(fallbackUrl);
};

// Banner art + copy for each department page (keyed by department slug)
const DEPARTMENT_PAGES = {
    'women': {
        title: "Women's Vintage",
        description: 'Tops, bottoms, dresses & more',
        banner: '/images/categories/women-banner.png'
    },
    'men': {
        title: "Men's Vintage",
        description: 'Tees, hoodies, flannels & more',
        banner: '/images/categories/men-banner.png'
    },
    'accessories': {
        title: 'Accessories',
        description: 'Bags, hats, jewelry & more',
        banner: '/images/categories/accessory-banner.png'
    },
    'new-arrivals': {
        title: 'New Arrivals',
        description: 'Fresh finds added regularly',
        banner: '/images/categories/new-arrivals-banner.png'
    }
};



app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));



app.use(express.static(path.join(__dirname, '../public')));
app.use('/icons', express.static(path.join(__dirname, '../icons')));
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));
app.use((req, res, next) => {
    if (req.originalUrl === '/webhooks/stripe') {
        return next();
    }

    return express.json({ limit: '15mb' })(req, res, next);
});
app.use((req, res, next) => {
    if (req.originalUrl === '/webhooks/stripe') {
        return next();
    }

    return express.urlencoded({ extended: true, limit: '15mb' })(req, res, next);
});
app.use(
	session({
		secret: process.env.SESSION_SECRET || 'dev-session-secret',
		resave: false,
		saveUninitialized: false,
		proxy: isProduction,
		cookie: {
			httpOnly: true,
			sameSite: 'lax',
			secure: isProduction,
			maxAge: 1000 * 60 * 60 * 24 * 7,
		},
	})
);
app.use((req, res, next) => {
    res.locals.currentUser = req.session.user || null;
    next();
});
app.use((req, res, next) => {
    res.locals.cartCount = Array.isArray(req.session.cart) ? req.session.cart.length : 0;
    res.locals.cartSkus = getSessionCart(req);
    next();
});

app.post('/cart/add', (req, res) => {
    const sku = String(req.body.sku || '').trim();

    if (!sku) {
        return res.status(400).json({ ok: false, error: 'Missing sku' });
    }

    const cart = addSkuToCart(req, sku);
    return sendCartResponse(req, res, {
        ok: true,
        action: 'added',
        sku,
        inCart: true,
        cartCount: cart.length
    });
});

app.post('/cart/remove', (req, res) => {
    const sku = String(req.body.sku || '').trim();

    if (!sku) {
        return res.status(400).json({ ok: false, error: 'Missing sku' });
    }

    const cart = removeSkuFromCart(req, sku);
    return sendCartResponse(req, res, {
        ok: true,
        action: 'removed',
        sku,
        inCart: false,
        cartCount: cart.length
    });
});

app.post('/cart/toggle', (req, res) => {
    const sku = String(req.body.sku || '').trim();

    if (!sku) {
        return res.status(400).json({ ok: false, error: 'Missing sku' });
    }

    const cart = toggleSkuInCart(req, sku);
    const inCart = cart.includes(sku);

    return sendCartResponse(req, res, {
        ok: true,
        action: inCart ? 'added' : 'removed',
        sku,
        inCart,
        cartCount: cart.length
    });
});

app.get('/', (req, res) => {
    return res.redirect('/shop');
});

app.get('/login', (req, res) => {
    if (req.session.user) {
        const returnTo = sanitizeReturnTo(req.query.returnTo, '/account');
        return res.redirect(returnTo);
    }

    return res.render('login', {
        currentPage: 'account',
        returnTo: sanitizeReturnTo(req.query.returnTo, '/account'),
        formSuccess: null,
        formError: null,
        formData: {
            email: ''
        }
    });
});

app.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    const returnTo = sanitizeReturnTo(req.body.returnTo, '/account');

    if (!supabaseAuth) {
        return res.status(500).render('login', {
            currentPage: 'account',
            returnTo,
            formSuccess: null,
            formError: 'Authentication is not configured on this server.',
            formData: {
                email
            }
        });
    }

    if (!email || !password) {
        return res.status(400).render('login', {
            currentPage: 'account',
            returnTo,
            formSuccess: null,
            formError: 'Please enter both email and password.',
            formData: {
                email
            }
        });
    }

    const { data, error } = await supabaseAuth.auth.signInWithPassword({
        email,
        password
    });

    if (error || !data || !data.user) {
        return res.status(401).render('login', {
            currentPage: 'account',
            returnTo,
            formSuccess: null,
            formError: getAuthErrorMessage(error, 'Unable to sign in. Please try again.'),
            formData: {
                email
            }
        });
    }

    req.session.user = buildSessionUserFromSupabaseUser(data.user, email);

    return req.session.save(() => res.redirect(returnTo));
});

app.get('/signup', (req, res) => {
    if (req.session.user) {
        return res.redirect('/account');
    }

    return res.render('signup', {
        currentPage: 'account',
        formError: null,
        formData: {
            email: '',
            displayName: ''
        }
    });
});

app.post('/signup', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    const displayName = String(req.body.displayName || '').trim();

    if (!supabaseAuth) {
        return res.status(500).render('signup', {
            currentPage: 'account',
            formError: 'Authentication is not configured on this server.',
            formData: {
                email,
                displayName
            }
        });
    }

    if (!email || !password) {
        return res.status(400).render('signup', {
            currentPage: 'account',
            formError: 'Please enter an email and password.',
            formData: {
                email,
                displayName
            }
        });
    }

    const { data, error } = await supabaseAuth.auth.signUp({
        email,
        password,
        options: {
            data: {
                display_name: displayName || email.split('@')[0]
            }
        }
    });

    if (error) {
        return res.status(400).render('signup', {
            currentPage: 'account',
            formError: getAuthErrorMessage(error, 'Unable to create account. Please try again.'),
            formData: {
                email,
                displayName
            }
        });
    }

    if (data && data.user && data.session) {
        req.session.user = buildSessionUserFromSupabaseUser(data.user, email);
        return req.session.save(() => res.redirect('/account'));
    }

    return res.status(200).render('login', {
        currentPage: 'account',
        returnTo: '/account',
        formSuccess: 'Account created. Check your email to confirm your address, then sign in.',
        formError: null,
        formData: {
            email
        }
    });
});

app.post('/logout', (req, res) => {
    req.session.user = null;
    return req.session.save(() => res.redirect('/shop'));
});

app.get('/account', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login?returnTo=%2Faccount');
    }

    try {
        const orders = await loadOrderHistoryForUser(req.session.user.id);

        return res.render('account', {
            currentPage: 'account',
            user: req.session.user,
            orders,
            ordersError: null
        });
    } catch (error) {
        console.error('[ACCOUNT] Failed to load order history:', error);

        return res.status(500).render('account', {
            currentPage: 'account',
            user: req.session.user,
            orders: [],
            ordersError: 'We could not load your order history right now. Please try again shortly.'
        });
    }
});

app.get('/about', async (req, res) => {
    try {
        const page = await loadMarkdownPage('about');

        if (!page) {
            return res.status(404).render('markdown-page', {
                currentPage: '',
                pageTitle: 'About',
                pageDescription: '',
                contentHtml: markdownToHtml('# About\n\nThis page is not available yet.'),
                backLinkHref: '/shop',
                backLinkLabel: 'Back to Shop'
            });
        }

        return renderMarkdownPage(res, {
            title: page.title || 'About',
            markdown: page.markdown,
            description: '',
            backLinkHref: '/shop',
            backLinkLabel: 'Back to Shop',
            currentPage: ''
        });
    } catch (error) {
        console.error('[ABOUT] Failed to load markdown page:', error);

        return res.status(500).render('markdown-page', {
            currentPage: '',
            pageTitle: 'About',
            pageDescription: '',
            contentHtml: markdownToHtml('# About\n\nWe could not load this page right now.'),
            backLinkHref: '/shop',
            backLinkLabel: 'Back to Shop'
        });
    }
});

app.get('/contact', (req, res) => {
    const currentUser = req.session.user || null;

    return renderContactPage(res, {
        currentUser,
        formData: {
            name: currentUser && currentUser.displayName ? currentUser.displayName : '',
            email: currentUser && currentUser.email ? currentUser.email : '',
            message: ''
        }
    });
});

app.post('/contact', async (req, res) => {
    const currentUser = req.session.user || null;
    const name = normalizeContactField(req.body.name);
    const email = normalizeContactField(req.body.email);
    const message = normalizeContactField(req.body.message);

    if (!message) {
        return renderContactPage(res, {
            currentUser,
            formData: {
                name,
                email,
                message
            },
            formError: 'Please enter a message before sending.',
            statusCode: 400
        });
    }

    const messageRecord = buildContactMessageBody({
        name,
        email,
        message,
        user: currentUser
    });

    try {
        const insertPayload = {
            message: messageRecord
        };

        if (currentUser && currentUser.id) {
            insertPayload.user_id = currentUser.id;
        }

        const insertedMessage = await supabase
            .from('messages')
            .insert(insertPayload)
            .select('id')
            .single();

        if (insertedMessage.error) {
            throw insertedMessage.error;
        }

        return renderContactPage(res, {
            currentUser,
            formData: {
                name: currentUser && currentUser.displayName ? currentUser.displayName : '',
                email: currentUser && currentUser.email ? currentUser.email : '',
                message: ''
            },
            formSuccess: 'Thanks. Your message has been sent.'
        });
    } catch (error) {
        console.error('[CONTACT] Failed to save message:', error);

        return renderContactPage(res, {
            currentUser,
            formData: {
                name,
                email,
                message
            },
            formError: 'We could not send your message right now. Please try again shortly.',
            statusCode: 500
        });
    }
});

const registerMarkdownPageRoute = (routePath, slug, fallbackTitle) => {
    app.get(routePath, async (req, res) => {
        try {
            const page = await loadMarkdownPage(slug);

            if (!page) {
                return res.status(404).render('markdown-page', {
                    currentPage: '',
                    pageTitle: fallbackTitle,
                    pageDescription: '',
                    contentHtml: markdownToHtml(`# ${fallbackTitle}\n\nThis page is not available yet.`),
                    backLinkHref: '/shop',
                    backLinkLabel: 'Back to Shop'
                });
            }

            return renderMarkdownPage(res, {
                title: page.title || fallbackTitle,
                markdown: page.markdown,
                description: '',
                backLinkHref: '/shop',
                backLinkLabel: 'Back to Shop',
                currentPage: ''
            });
        } catch (error) {
            console.error(`[PAGE] Failed to load ${slug} markdown page:`, error);

            return res.status(500).render('markdown-page', {
                currentPage: '',
                pageTitle: fallbackTitle,
                pageDescription: '',
                contentHtml: markdownToHtml(`# ${fallbackTitle}\n\nWe could not load this page right now.`),
                backLinkHref: '/shop',
                backLinkLabel: 'Back to Shop'
            });
        }
    });
};

registerMarkdownPageRoute('/shipping', 'shipping', 'Shipping');
registerMarkdownPageRoute('/returns', 'returns', 'Returns');
registerMarkdownPageRoute('/faq', 'faq', 'FAQ');

app.get('/pages/:slug', async (req, res) => {
    const page = await loadMarkdownPage(req.params.slug);

    if (!page) {
        return res.status(404).render('markdown-page', {
            currentPage: '',
            pageTitle: 'Page not found',
            pageDescription: '',
            contentHtml: markdownToHtml('# Page not found\n\nThe requested markdown page does not exist.'),
            backLinkHref: '/shop',
            backLinkLabel: 'Back to Shop'
        });
    }

    return renderMarkdownPage(res, {
        title: page.title,
        markdown: page.markdown,
        description: '',
        backLinkHref: '/shop',
        backLinkLabel: 'Back to Shop',
        currentPage: ''
    });
});

app.get('/account/orders/:orderId', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login?returnTo=%2Faccount');
    }

    const orderId = Number.parseInt(String(req.params.orderId || '').trim(), 10);
    if (!Number.isFinite(orderId) || orderId <= 0) {
        return res.status(404).render('account-order', {
            currentPage: 'account',
            user: req.session.user,
            order: null,
            orderItems: [],
            notFound: true,
            loadError: null
        });
    }

    try {
        const orderQuery = await supabase
            .from('order_info')
            .select(`
                id,
                user_id,
                stripe_session_id,
                stripe_payment_intent_id,
                status,
                customer_name,
                customer_email,
                customer_phone,
                shipping_address_line1,
                shipping_address_line2,
                shipping_city,
                shipping_state,
                shipping_postal_code,
                shipping_country,
                subtotal,
                shipping_amount,
                tax_amount,
                total_amount,
                carrier,
                shipping_service,
                tracking_number,
                shipping_label_url,
                postage_cost,
                created_at,
                paid_at,
                shipped_at,
                delivered_at,
                cancelled_at
            `)
            .eq('id', orderId)
            .eq('user_id', req.session.user.id)
            .maybeSingle();

        if (orderQuery.error) {
            throw orderQuery.error;
        }

        const order = orderQuery.data;

        if (!order) {
            return res.status(404).render('account-order', {
                currentPage: 'account',
                user: req.session.user,
                order: null,
                orderItems: [],
                notFound: true,
                loadError: null
            });
        }

        const orderItemQuery = await supabase
            .from('order_info_item')
            .select('order_info_id,sku')
            .eq('order_info_id', order.id);

        if (orderItemQuery.error) {
            throw orderItemQuery.error;
        }

        const orderItemRows = orderItemQuery.data || [];
        const skus = orderItemRows.map(row => row.sku);
        const { listingBySku, firstImageBySku } = await loadListingSnapshotsBySkus(skus);
        const orderItems = enrichOrderItems(orderItemRows, listingBySku, firstImageBySku);

        return res.render('account-order', {
            currentPage: 'account',
            user: req.session.user,
            order,
            orderItems,
            notFound: false,
            loadError: null
        });
    } catch (error) {
        console.error('[ACCOUNT] Failed to load order detail:', error);

        return res.status(500).render('account-order', {
            currentPage: 'account',
            user: req.session.user,
            order: null,
            orderItems: [],
            notFound: false,
            loadError: 'We could not load this order right now. Please try again shortly.'
        });
    }
});

app.get('/shop', async (req, res) => {
    try {

        // Get all listings
        const { data: listings, error: listingError } = await supabase
            .from('listing')
            .select(`
                title,
                description,
                price,
                sku,
                category_id,
                created_at,
                aspects
            `)
            .eq('state', 1)
            .order('created_at', { ascending: false });
        if (listingError) {
            throw listingError;
        }


        // Get all listing images
        const { data: images, error: imageError } = await supabase
            .from('listing_image')
            .select(`
                id,
                sku,
                image_url
            `)
            .order('id', { ascending: true });

        if (imageError) {
            throw imageError;
        }


        // Attach images to their listing using SKU
        let products = listings.map(listing => {

            const listingImages = images.filter(
                image => image.sku === listing.sku
            );

            return {
                ...listing,
                images: listingImages
            };
        });

        const departmentSlug = req.query.department;

        // Category pills submit as a single value or an array of checked values
        let categorySlugs = req.query.category;
        if (!categorySlugs) {
            categorySlugs = [];
        } else if (!Array.isArray(categorySlugs)) {
            categorySlugs = [categorySlugs];
        }
        categorySlugs = categorySlugs.filter(slug => slug && slug !== 'all');

        const isNewArrivals = departmentSlug === 'new-arrivals';
        const departmentKey = !isNewArrivals && departmentSlug
            ? findCategoryKey(majorCategories, departmentSlug)
            : null;
        const isDepartmentPage = isNewArrivals || Boolean(departmentKey);

        if (isNewArrivals) {

            products = products.slice(0, NEW_ARRIVALS_LIMIT);

        } else if (departmentKey) {

            products = products.filter(
                product => majorCategories[departmentKey].includes(product.category_id)
            );
        }

        if (categorySlugs.length) {

            // Union of every checked category's category_id list (OR filter)
            const matchedCategoryIds = new Set();

            categorySlugs.forEach(slug => {
                const categoryKey = findCategoryKey(minorCategories, slug);
                if (categoryKey) {
                    minorCategories[categoryKey].forEach(id => matchedCategoryIds.add(id));
                }
            });

            if (matchedCategoryIds.size) {
                products = products.filter(product => matchedCategoryIds.has(product.category_id));
            }
        }

        // Women/Men are redundant once a department already scopes by gender
        const minorPills = [
            { label: 'All Items', slug: 'all' },
            ...Object.keys(minorCategories)
                .filter(name => !(isDepartmentPage && (name === 'Women' || name === 'Men')))
                .map(name => ({
                    label: name,
                    slug: slugify(name)
                }))
        ];

        let activeColors = req.query.color;
        if (!activeColors) {
            activeColors = [];
        } else if (!Array.isArray(activeColors)) {
            activeColors = [activeColors];
        }
        activeColors = [...new Set(activeColors
            .map(value => normalizeColorName(value))
            .filter(Boolean))];

        let activeBrands = req.query.brand;
        if (!activeBrands) {
            activeBrands = [];
        } else if (!Array.isArray(activeBrands)) {
            activeBrands = [activeBrands];
        }
        activeBrands = [...new Set(activeBrands.map(value => normalizeFilterValue(value)).filter(Boolean))];

        let activeSizes = req.query.size;
        if (!activeSizes) {
            activeSizes = [];
        } else if (!Array.isArray(activeSizes)) {
            activeSizes = [activeSizes];
        }
        activeSizes = [...new Set(activeSizes.map(value => normalizeFilterValue(value)).filter(Boolean))];

        const colorFilters = buildColorCounts(products);
        const brandFilters = buildFacetCounts(products, extractProductBrand);
        const sizeFilters = buildFacetCounts(products, extractProductSize);

        if (activeColors.length) {
            products = products.filter(product => {
                const productColors = extractProductColors(product);
                return productColors.some(color => activeColors.includes(color));
            });
        }

        if (activeBrands.length) {
            products = products.filter(product => {
                const productBrands = extractProductBrand(product);
                return productBrands.some(brand => activeBrands.includes(brand));
            });
        }

        if (activeSizes.length) {
            products = products.filter(product => {
                const productSizes = extractProductSize(product);
                return productSizes.some(size => activeSizes.includes(size));
            });
        }

        if (isDepartmentPage) {

            const departmentLabel = isNewArrivals ? 'New Arrivals' : departmentKey;
            const departmentPage = DEPARTMENT_PAGES[departmentSlug] || {};

            return res.render('department', {
                products,
                minorPills,
                colorFilters,
                brandFilters,
                sizeFilters,
                activeColors,
                activeBrands,
                activeSizes,
                activeDepartment: departmentSlug,
                activeCategories: categorySlugs,
                departmentLabel,
                departmentTitle: departmentPage.title || departmentLabel,
                departmentDescription: departmentPage.description || '',
                departmentBanner: departmentPage.banner || ''
            });
        }

        return res.render('shop', {
            products,
            minorPills,
            colorFilters,
            brandFilters,
            sizeFilters,
            activeColors,
            activeBrands,
            activeSizes,
            activeDepartment: '',
            activeCategories: categorySlugs
        });

    } catch (error) {

        console.error('[SHOP] Failed to load listings:', error);

        if (req.query.department) {

            const departmentPage = DEPARTMENT_PAGES[req.query.department] || {};

            return res.status(500).render('department', {
                products: [],
                minorPills: [],
                colorFilters: [],
                brandFilters: [],
                sizeFilters: [],
                activeColors: [],
                activeBrands: [],
                activeSizes: [],
                activeDepartment: req.query.department,
                activeCategories: [],
                departmentLabel: departmentPage.title || '',
                departmentTitle: departmentPage.title || '',
                departmentDescription: departmentPage.description || '',
                departmentBanner: departmentPage.banner || ''
            });
        }

        return res.status(500).render('shop', {
            products: [],
            minorPills: [],
            colorFilters: [],
            brandFilters: [],
            sizeFilters: [],
            activeColors: [],
            activeBrands: [],
            activeSizes: [],
            activeDepartment: '',
            activeCategories: []
        });
    }
});

app.get('/cart', async (req, res) => {
    const isLoggedIn = Boolean(req.session.user);

    try {
        const { cartItems, subtotal, shipping, tax, total, cartCount } = await loadCartData(req);

        return res.render('cart', {
            cartItems,
            subtotal,
            shipping,
            tax,
            total,
            cartCount,
            isLoggedIn,
            showLoginPrompt: !isLoggedIn
        });
    } catch (error) {
        console.error('[CART] Failed to load cart:', error);

        return res.status(500).render('cart', {
            cartItems: [],
            subtotal: 0,
            shipping: 0,
            tax: 0,
            total: 0,
            cartCount: 0,
            isLoggedIn,
            showLoginPrompt: !isLoggedIn
        });
    }
});

app.get('/checkout', (req, res) => {
    return res.redirect('/cart');
});

app.post('/checkout/stripe', async (req, res) => {
    if (!stripe) {
        return res.status(500).send('Stripe is not configured.');
    }

    try {
        const { cartItems, subtotal, shipping, total } = await loadCartData(req);

        if (!cartItems.length) {
            return res.redirect('/cart');
        }

        const baseUrl = getBaseUrl(req);
        const lineItems = buildStripeLineItems(req, cartItems);

        if (shipping > 0) {
            lineItems.push({
                quantity: 1,
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Shipping',
                        description: `Standard shipping for ${cartItems.length} item${cartItems.length === 1 ? '' : 's'}`
                    },
                    unit_amount: Math.round(shipping * 100)
                }
            });
        }

        const userId = req.session && req.session.user && req.session.user.id
            ? String(req.session.user.id)
            : '';

        const metadata = {
            session_id: req.sessionID,
            cart_count: String(cartItems.length),
            cart_skus: cartItems.map(item => String(item.sku || '').trim()).filter(Boolean).join(','),
            subtotal: String(subtotal || 0),
            shipping: String(shipping || 0),
            total: String(total || 0)
        };

        if (userId) {
            metadata.user_id = userId;
        }

        const sessionData = await stripe.checkout.sessions.create({
            mode: 'payment',
            allow_promotion_codes: true,
            line_items: lineItems,
            automatic_tax: {
                enabled: true
            },
            billing_address_collection: 'required',
            shipping_address_collection: {
                allowed_countries: ['US']
            },
            custom_text: {
                submit: {
                    message: 'Thanks for shopping one-of-one vintage with Nine Lives Vintage.'
                }
            },
            success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${baseUrl}/checkout/cancel`,
            metadata
        });

        return res.redirect(303, sessionData.url);
    } catch (error) {
        console.error('[STRIPE] Failed to create checkout session:', error);
        return res.redirect('/cart');
    }
});

app.post('/webhooks/stripe', async (req, res) => {
    if (!stripe) {
        return res.status(500).send('Stripe is not configured.');
    }

    const signature = req.get('stripe-signature');
    const payload = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');

    let event;

    try {
        if (stripeWebhookSecret && signature) {
            event = stripe.webhooks.constructEvent(payload, signature, stripeWebhookSecret);
        } else {
            event = JSON.parse(payload);
        }
    } catch (error) {
        console.error('[STRIPE] Webhook signature verification failed:', error);
        return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
        if (event.type === 'checkout.session.completed') {
            const rawCheckoutSession = event.data.object;
            const expandedSession = await stripe.checkout.sessions.retrieve(rawCheckoutSession.id, {
                expand: ['line_items.data.price.product']
            });

            const sessionId = expandedSession?.metadata?.session_id;
            const purchasedSkus = getPurchasedSkusFromSession(expandedSession);

            await saveCompletedOrder({
                checkoutSession: expandedSession,
                purchasedSkus
            });

            await archivePurchasedListings(purchasedSkus);

            if (sessionId) {
                await persistSessionCart(req, sessionId, []);
            }
        }

        return res.json({ received: true });
    } catch (error) {
        console.error('[STRIPE] Failed to process webhook event:', error);
        return res.status(500).json({ received: false });
    }
});

app.get('/checkout/success', async (req, res) => {
    if (!stripe) {
        return res.redirect('/cart');
    }

    const sessionId = String(req.query.session_id || '').trim();

    if (!sessionId) {
        return res.redirect('/cart');
    }

    try {
        const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
            expand: ['line_items']
        });

        if (checkoutSession.payment_status === 'paid') {
            req.session.cart = [];
        }

        return res.render('checkout-success', {
            checkoutSession,
            cartCount: 0
        });
    } catch (error) {
        console.error('[STRIPE] Failed to load checkout success page:', error);
        return res.redirect('/cart');
    }
});

app.get('/checkout/cancel', (req, res) => {
    return res.render('checkout-cancel', {
        cartCount: Array.isArray(req.session.cart) ? req.session.cart.length : 0
    });
});

app.get('/product/:sku', async (req, res) => {
    const sku = String(req.params.sku || '').trim();

    const renderPayload = {
        product: null,
        colorChips: [],
        brand: '',
        size: '',
        specs: [],
        relatedProducts: []
    };

    if (!sku) {
        return res.status(404).render('product', renderPayload);
    }

    try {
        const { data: listing, error: listingError } = await supabase
            .from('listing')
            .select(`
                title,
                description,
                price,
                sku,
                category_id,
                created_at,
                aspects
            `)
            .eq('sku', sku)
            .eq('state', 1)
            .maybeSingle();

        if (listingError) {
            throw listingError;
        }

        if (!listing) {
            return res.status(404).render('product', renderPayload);
        }

        const { data: productImages, error: imageError } = await supabase
            .from('listing_image')
            .select(`
                id,
                sku,
                image_url
            `)
            .eq('sku', sku)
            .order('id', { ascending: true });

        if (imageError) {
            throw imageError;
        }

        const product = {
            ...listing,
            images: productImages || []
        };

        const aspects = getProductAspects(product);
        const hiddenFacetLabels = new Set(['brand', 'size', 'color']);

        const specs = Object.entries(aspects)
            .map(([key, entry]) => {
                if (!entry || typeof entry !== 'object') {
                    return null;
                }

                const value = normalizeFilterValue(String(entry.value ?? ''));

                if (!value) {
                    return null;
                }

                const normalizedKey = normalizeFacetKey(key);
                const normalizedLabel = normalizeFacetKey(entry.label || '');

                if (hiddenFacetLabels.has(normalizedKey) || hiddenFacetLabels.has(normalizedLabel)) {
                    return null;
                }

                const prettyLabel = normalizeFilterValue(String(entry.label || '')) || key
                    .replace(/^aspect[-_]/i, '')
                    .replace(/[-_]+/g, ' ')
                    .replace(/\b\w/g, char => char.toUpperCase());

                return {
                    label: prettyLabel,
                    value
                };
            })
            .filter(Boolean);

        const colorChips = extractProductColors(product).map(color => ({
            label: color,
            hex: COLOR_HEX_MAP[color] || '#cccccc'
        }));

        const brand = normalizeFilterValue(getAspectValue(product, ['aspect-brand', 'brand', 'aspect_brand']));
        const size = normalizeFilterValue(getAspectValue(product, ['aspect-size', 'size', 'aspect_size']));
        const isInCart = cartHasSku(req, product.sku);

        let relatedProducts = [];

        if (product.category_id) {
            const { data: relatedListings, error: relatedError } = await supabase
                .from('listing')
                .select(`
                    title,
                    description,
                    price,
                    sku,
                    category_id,
                    created_at,
                    aspects
                `)
                .eq('category_id', product.category_id)
                .neq('sku', product.sku)
                .eq('state', 1)
                .order('created_at', { ascending: false })
                .limit(4);

            if (relatedError) {
                throw relatedError;
            }

            const relatedSkus = (relatedListings || []).map(item => item.sku);

            let relatedImages = [];
            if (relatedSkus.length) {
                const { data: fetchedRelatedImages, error: relatedImagesError } = await supabase
                    .from('listing_image')
                    .select(`
                        id,
                        sku,
                        image_url
                    `)
                    .in('sku', relatedSkus)
                    .order('id', { ascending: true });

                if (relatedImagesError) {
                    throw relatedImagesError;
                }

                relatedImages = fetchedRelatedImages || [];
            }

            relatedProducts = (relatedListings || []).map(item => ({
                ...item,
                images: relatedImages.filter(image => image.sku === item.sku)
            }));
        }

        return res.render('product', {
            product,
            colorChips,
            brand,
            size,
            isInCart,
            cartActionImage: isInCart ? '/images/remove-from-cart.png' : '/images/add-to-cart.png',
            cartActionLabel: isInCart ? 'Remove from Cart' : 'Add to Cart',
            specs,
            relatedProducts
        });
    } catch (error) {
        console.error('[PRODUCT] Failed to load product:', error);
        return res.status(500).render('product', renderPayload);
    }
});

module.exports = app;
module.exports.COLOR_OPTIONS = COLOR_OPTIONS;
module.exports.COLOR_HEX_MAP = COLOR_HEX_MAP;
module.exports.normalizeColorName = normalizeColorName;
module.exports.extractProductColors = extractProductColors;
module.exports.buildColorCounts = buildColorCounts;
module.exports.extractProductBrand = extractProductBrand;
module.exports.extractProductSize = extractProductSize;
module.exports.buildFacetCounts = buildFacetCounts;
module.exports.loadMarkdownPage = loadMarkdownPage;
module.exports.renderMarkdownPage = renderMarkdownPage;