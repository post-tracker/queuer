const https = require( 'https' );

const got = require( 'got' );
const sha1 = require( 'sha1' );

const API_HOST = 'api.kokarn.com';
const API_PORT = 443;
// const API_HOST = 'localhost';
// const API_PORT = 3000;

const EXISTING_CUTOFF = 5;
const EXISTS_STATUS_CODE = 200;

const gotOptions = {
    headers: {
        'user-agent': 'Queue indexer 1.0.0 by /u/Kokarn',
    },
    json: true,
};

class Reddit {
    constructor () {
        this.apiBase = 'https://www.reddit.com';
        this.userPostsUrl = '/user/{username}.json';
    }

    inValidSection ( postSection, allowedSections, disallowedSections ) {
        if ( allowedSections && allowedSections.length > 0 ) {
            if ( allowedSections.indexOf( postSection ) === -1 ) {
                // console.error( 'Post is not in an allowed section' );

                return false;
            }
        }

        if ( disallowedSections && disallowedSections.length > 0 ) {
            if ( disallowedSections.indexOf( postSection ) > -1 ) {
                // console.error( `Post is in an disallowed section (${ this.section })` );

                return false;
            }
        }

        return true;
    }

    getPostUrl ( post ) {
        switch ( post.kind ) {
            case 't1':
                return `${ post.data.link_url }${ post.data.id }/`;

                break;
            case 't3':
                return post.data.url;

                break;
            default:
                console.error( `Unkown reddit type ${ post.kind }` );
                return false;

                break;
        }
    }

    postExists ( hash ) {
        return new Promise( ( resolve, reject ) => {
            const options = {
                hostname: API_HOST,
                method: 'HEAD',
                path: `/admin/posts/${ hash }`,
                port: API_PORT,
                rejectUnauthorized: false,
            };

            const request = https.request( options, ( response ) => {
                response.setEncoding( 'utf8' );

                if ( response.statusCode === EXISTS_STATUS_CODE ) {
                    resolve( true );

                    return false;
                }

                resolve( false );

                return true;
            } );

            request.on( 'error', ( requestError ) => {
                reject( requestError );
            } );

            request.end();
        } );
    }

    async isNewPost ( post ) {
        const postUrl = this.getPostUrl( post );
        let postExists = false;

        try {
            postExists = await this.postExists( sha1( postUrl ) );
        } catch ( postError ) {
            throw postError;
        }

        return !postExists;
    }

    async findNewPosts ( userId, allowedSections = [], disallowedSections = [] ) {
        const url = this.apiBase + this.userPostsUrl.replace( '{username}', userId );
        const newPosts = [];
        let posts;

        try {
            const postsData = await got( url, gotOptions );
            posts = postsData.body.data;
        } catch ( requestError ) {
            console.log( requestError );

            return requestError;
        }

        if ( !posts.children ) {
            console.log( `Something is broken with ${ url }` );

            return false;
        }

        let existCount = 0;
        for ( let postIndex = 0; postIndex < posts.children.length; postIndex = postIndex + 1 ) {

            // If we found a number of pre-existing posts in a row, we've probably got them all
            if ( existCount > EXISTING_CUTOFF ) {
                break;
            }

            if ( !posts.children[ postIndex ].data.selftext_html && !posts.children[ postIndex ].data.body_html ) {
                // Post has no content
                console.log( `Skipping post because it's missing content` );
                continue;
            }

            if ( !this.inValidSection( posts.children[ postIndex ].data.subreddit, allowedSections, disallowedSections ) ) {
                continue;
            }

            if ( await this.isNewPost( posts.children[ postIndex ] ) ) {
                existCount = 0;
                newPosts.push( posts.children[ postIndex ] );
            } else {
                existCount = existCount + 1;
            }
        }

        return newPosts;
    }
}

module.exports = new Reddit();
