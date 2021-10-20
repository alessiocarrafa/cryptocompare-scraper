
const fastify = require('fastify')({ logger: true })
const axios = require('axios');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

// configuration file
const config = require('./conf.json');
// supported coin
const managedCoins = require('./coins.json');

const PriceSampleStructure = {};
// create mongoose object structure based on supported coins
managedCoins.forEach( coin => PriceSampleStructure[coin] = Number);

// cryptocompare api set
const cryptocompareApi = {
  getAllCoinList: 'https://min-api.cryptocompare.com/data/all/coinlist',
  priceMulti: 'https://min-api.cryptocompare.com/data/pricemulti',
  priceMultiFull: 'https://min-api.cryptocompare.com/data/pricemultifull',
  priceSingle: 'https://min-api.cryptocompare.com/data/price',
};

(async () => {
  let PriceSample = null;

  let coinList = null;
  let symbolList = null;

  // utility cb for filter available coins
  const symbolsHandled = (xsym) => managedCoins.indexOf(xsym) !== -1 && symbolList.indexOf(xsym) !== -1;

  // cb for update cryptocompare supported coin list
  const updateCoinList = async () => {
    const { data } = await axios.get(cryptocompareApi.getAllCoinList);
    coinList = data.Data;
    symbolList = Object.keys(data.Data);
  }

  fastify.route({
    method: 'GET',
    url: '/service/price',
    schema: {
      querystring: {
        fsyms: { type: 'string' },
        tsyms: { type: 'string' }
      }
    },
    handler: async (request) => {
      const { fsyms, tsyms } = request.query;

      const desiredFsyms = fsyms.split(',');
      const desiredTsyms = tsyms.split(',');

      const handledFsyms = desiredFsyms.filter(symbolsHandled);
      const handledTsyms = desiredTsyms.filter(symbolsHandled);

      if( handledFsyms.length && handledTsyms.length ) {
        try{
          const { data } = await axios.get(cryptocompareApi.priceMulti, {
            params: {
              fsyms: handledFsyms.join(','),
              tsyms: handledTsyms.join(','),
            }
          });
      
          return { data }
        }
        catch( error ){ // an error occur while get live data from api, get data from local db
          const lastSample = ( await PriceSample.find({}).limit(1).sort({$natural:-1}) )[0];

          const toRet = {};
          handledFsyms.forEach( fsym => {
            toRet[ fsym ] = {};
            // foreach hanlded coins
            handledTsyms.forEach( tsym => {
              // return the ration between fsym and tsym based on usd value
              toRet[ fsym ][ tsym ] = lastSample[ tsym ] / lastSample[ fsym ];
            });
          });

          return { data: toRet };
        }
      }
      
      return { error: 'coin not handled' }
    }
  })

  // test fallback api
  fastify.route({
    method: 'GET',
    url: '/service/localprice',
    schema: {
      querystring: {
        fsyms: { type: 'string' },
        tsyms: { type: 'string' }
      }
    },
    handler: async (request, reply) => {
      const { fsyms, tsyms } = request.query;

      const desiredFsyms = fsyms.split(',');
      const desiredTsyms = tsyms.split(',');

      const handledFsyms = desiredFsyms.filter(symbolsHandled);
      const handledTsyms = desiredTsyms.filter(symbolsHandled);

      if( handledFsyms.length && handledTsyms.length ) {
        const lastSample = ( await PriceSample.find({}).limit(1).sort({$natural:-1}) )[0];

        const toRet = {};
        handledFsyms.forEach( fsym => {
          toRet[ fsym ] = {};
          handledTsyms.forEach( tsym => {
            toRet[ fsym ][ tsym ] = lastSample[ tsym ] / lastSample[ fsym ];
          });
        })

        return { data: toRet }
      }
      
      return { error: 'coin not handled' }
    }
  })

  try {
    // create mongodb instance in memory and automatically start it
    const mongod = await MongoMemoryServer.create();
    const uri = mongod.getUri();
    mongoose.connect(uri);
    PriceSample = mongoose.model('PriceSample', PriceSampleStructure);

    await updateCoinList(); // not returning fiat
    await fastify.listen(config.localPort);

    // update cryptocompare supported coin list schedule
    setInterval(() => updateCoinList(), config.coinListFetchInterval);

    // save supported coins usd value into db as fallback
    setInterval(async () => {
      const { data } = await axios.get(cryptocompareApi.priceSingle, {
        params: {
          fsym: 'USD',
          tsyms: managedCoins.join(','),
        }
      });

      const sample = new PriceSample(data);
      sample.save().then(() => console.log('sample saved'));
    }, config.coinDataFetchInterval);
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})();