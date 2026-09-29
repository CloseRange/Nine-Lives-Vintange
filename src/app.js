
const express = require('express');
const path = require('path');
const session = require('express-session');
    
const isProduction = process.env.NODE_ENV === 'production';
const app = express();

const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    { realtime: { transport: WebSocket } } // Node < 22 lacks a native WebSocket the realtime client can use
);

const majorCategories = require('../public/major_category.json');
const minorCategories = require('../public/minor_category.json');

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Finds the JSON key whose slug matches the given query param value
const findCategoryKey = (categories, slug) =>
    Object.keys(categories).find(key => slugify(key) === slug);

const NEW_ARRIVALS_LIMIT = 20;

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
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
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
app.get('/', (req, res) => {
    return res.redirect('/shop');
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

        if (isDepartmentPage) {

            const departmentLabel = isNewArrivals ? 'New Arrivals' : departmentKey;
            const departmentPage = DEPARTMENT_PAGES[departmentSlug] || {};

            return res.render('department', {
                products,
                minorPills,
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
            activeDepartment: '',
            activeCategories: []
        });
    }
});
module.exports = app;