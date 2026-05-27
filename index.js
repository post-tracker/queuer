const fs = require( 'fs' );
const path = require( 'path' );

const chalk = require( 'chalk' );
const got = require( 'got' );
const Queue = require( 'bull' );
const now = require( 'performance-now' );

const indexers = require( './indexers/' );

// const API_TOKEN = process.env.API_TOKEN;
const API_TOKEN = 'G4SvsrFSSjh9AgmAWKdUEY62';
process.env.REDIS_URL = 'redis://:pb1ee13e3a36e25e02b2237f9ec45cc73a00c13d011fee4e23a9101350a5c7fa2@ec2-108-128-174-156.eu-west-1.compute.amazonaws.com:32649';

if ( !API_TOKEN ) {
    throw new Error( 'Unable to load API token' );
}

if ( !process.env.REDIS_URL ) {
    throw new Error( 'Got no queue string, exiting' );
}

const MAX_INDEX_TIME = ( 8 * 60 * 1000 ); // 8 minutes
// Reddit unauth limit is ~10 req/min/IP. Pace at ~9 req/min to stay under it.
const MIN_REQUEST_TIMING = 6500;
let requestTiming = MIN_REQUEST_TIMING;

const requestOptions = {
    headers: {
        Authorization: `Bearer ${ API_TOKEN }`,
    },
    json: true,
};

const redditQueue = new Queue(
    'reddit-posts',
    process.env.REDIS_URL,
);

const addJobToQueue = function addJobToQueue ( accountId, gameIdentifier, jobData ) {
    // console.log( `Adding job ${ jobData.data.id }` );

    return redditQueue.add( {
        accountId: accountId,
        game: gameIdentifier,
        post: jobData,
    }, {
        removeOnComplete: true,
        jobId: jobData.data.id,
    } )
};

const sleep = function sleep( ms ) {
    console.log( `Sleeping for ${ ms }ms` );

    return new Promise( ( resolve ) => {
        setTimeout( resolve, ms );
    } );
};

console.time( 'Indexer' );

process.on( 'exit', () => {
    console.timeEnd( 'Indexer' );
} );

const indexGame = function indexGame ( gameData ) {
    // console.log( `Indexing ${ gameData.identifier }` );
    return new Promise( async ( resolve, reject ) => {
        // console.log( `Checking ${ gameData.accounts.length } devs for ${ gameData.identifier }` );
        let indexPromises = [];

        for ( let accountIndex = 0; accountIndex < gameData.accounts.length; accountIndex = accountIndex + 1 ) {
            // console.log( `Finding posts for ${ gameData.accounts[ accountIndex ].identifier }` );
            const start = now();

            indexPromises.push( indexers.reddit.findNewPosts( gameData.accounts[ accountIndex ].identifier, gameData.allowedSections, gameData.disallowedSections )
                .then( ( newPosts ) => {
                    let addJobs = [];

                    for( let i = 0; i < newPosts.length; i = i + 1 ) {
                        addJobs.push( addJobToQueue( gameData.accounts[ accountIndex ].id, gameData.identifier, newPosts[ i ] ) );
                    }

                    return Promise.all( addJobs );
                } )
                .catch( ( indexError ) => {
                    console.error( indexError );
                } )
            );

            const end = now();

            // Make sure we don't do more than 1 request / MIN_REQUEST_TIMING ms
            if ( end - start < requestTiming ) {
                await sleep( Math.max( requestTiming, MIN_REQUEST_TIMING ) - ( end - start ) );
            }
        }

        Promise.all( indexPromises )
            .then( () => {
                resolve();
            } );
    } );
};


const run = async function run () {
    const gamePromises = [];
    let gamesResponse = false;
    let totalAccounts = 0;

    try {
        gamesResponse = await got( `https://api.developertracker.com/games`, requestOptions );
    } catch ( gameDataError ) {
        throw gameDataError;
    }

    const gameData = {};

    gamesResponse.body.data.forEach( ( gameConfig ) => {
        if ( gameConfig.config && gameConfig.config.sources ) {
            gameData[ gameConfig.identifier ] = gameConfig.config.sources;
        }
    } );

    Object.keys( gameData ).forEach( ( gameIdentifier ) => {
        gamePromises.push( got( `https://api.developertracker.com/${ gameIdentifier }/accounts?active=1`, requestOptions )
            .then( ( accountResponse ) => {
                const accounts = [];

                for ( let i = 0; i < accountResponse.body.data.length; i = i + 1 ) {
                    if ( accountResponse.body.data[ i ].service === 'Reddit' ) {
                        accounts.push( accountResponse.body.data[ i ] );

                        totalAccounts = totalAccounts + 1;
                    }
                }

                return {
                    accounts: accounts,
                    identifier: gameIdentifier,
                    allowedSections: gameData[ gameIdentifier ][ 'Reddit' ].allowedSections,
                    disallowedSections: gameData[ gameIdentifier ][ 'Reddit' ].disallowedSections,
                };
            } )
            .catch( ( something ) => {
                console.log( 'GOT ERROR' );
                console.log( something );
            } )
        );
    } );

    const allGameData = await Promise.all( gamePromises );

    console.log( `Got ${ totalAccounts } Reddit accounts` );
    requestTiming = Math.round( MAX_INDEX_TIME / totalAccounts );

    for ( const game of allGameData ) {
        if ( game.identifier !== 'dayz' ) {
            continue;
        }

        console.time( game.identifier );
        await indexGame( game );
        console.timeEnd( game.identifier );
    }
};

const RUN_INTERVAL_MS = Number( process.env.RUN_INTERVAL_MS ) || ( 60 * 60 * 1000 );

const loop = async function loop() {
    while ( true ) {
        try {
            await run();
        } catch ( error ) {
            console.error( error );
        }

        await new Promise( ( resolve ) => {
            setTimeout( resolve, RUN_INTERVAL_MS );
        } );
    }
};

const shutdown = async function shutdown() {
    console.log( 'Shutting down' );

    try {
        await redditQueue.close();
    } catch ( closeError ) {
        console.error( closeError );
    }

    process.exit( 0 );
};

process.on( 'SIGTERM', shutdown );
process.on( 'SIGINT', shutdown );

loop();
