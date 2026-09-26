require('dotenv').config();

const app = require('./app');

const PORT = process.env.PORT || 3000;

const runPricingCheck = async () => {
  if (typeof app.applyPriceRateLadder === 'function') {
    await app.applyPriceRateLadder();
  }
};

void runPricingCheck();

setInterval(() => {
  const now = new Date();
  if (now.getHours() === 11 && now.getMinutes() < 2) {
    void runPricingCheck();
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`eBay Helper running at http://localhost:${PORT}`);
});



app.use((req, res, next) => {
	if (typeof req.session.isEbayConnected !== 'boolean') {
		req.session.isEbayConnected = false;
	}
	if (req.session.isEbayConnected === true && !req.session.isEbayConnectedVerifiedAt) {
		req.session.isEbayConnected = false;
	}
	res.locals.currentUser = req.session.user || null;
	res.locals.currentPath = req.path || '/';
	res.locals.isEbayConnected = req.session.isEbayConnected;
	next();
});

app.get('/', (req, res) => {
	return res.redirect('/dashboard');
});