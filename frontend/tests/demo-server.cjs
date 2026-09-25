// Local visual demo only. Never imports this fixture into the production app.
process.env.FIXTURE_PUBLISHED = "1";
process.env.FIXTURE_PORT ||= "5173";
require("./fixture-server.cjs");
