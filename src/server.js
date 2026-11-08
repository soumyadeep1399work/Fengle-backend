require("dotenv").config();
const app = require("./app");

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT} [${process.env.NODE_ENV || "development"}]`);
  // Sends scheduled notification campaigns when they come due. Started here, not in app.js, so tests
  // and tools that load the app never run it; the API runs as one PM2 instance, so one timer is enough.
  require("./services/campaign.service").startScheduler();
  // Safety net for orders waiting on a rider (accepted, no one free yet): the event triggers do the work, this catches misses.
  require("./services/riderDispatch.service").startTick();
  // Re-sends the kitchen's loud new-order alert until the order is acknowledged, accepted or rejected.
  require("./services/kitchenAlert.service").startTick();
  // The same for riders: re-sends the loud new-delivery alert until the assigned rider acknowledges or picks the order up.
  require("./services/riderAlert.service").startTick();
  // Cancels online-payment orders nobody paid for (PAYMENT_EXPIRY_MINUTES, default 5); also clears the backlog once at boot.
  require("./services/unpaidOrders.service").startTick();
});
