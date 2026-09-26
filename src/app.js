
const express = require('express');
const path = require('path');
const session = require('express-session');
    
const isProduction = process.env.NODE_ENV === 'production';
const app = express();

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);



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
        const products = listings.map(listing => {

            const listingImages = images.filter(
                image => image.sku === listing.sku
            );

            return {
                ...listing,
                images: listingImages
            };
        });


        return res.render('shop', {
            products
        });

    } catch (error) {

        console.error('[SHOP] Failed to load listings:', error);

        return res.status(500).render('shop', {
            products: []
        });
    }
});
module.exports = app;