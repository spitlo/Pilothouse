const chalk = require('chalk'),
      commands = require('./commands'),
      config = require('./config'),
      environment = require('./environment'),
      fs = require('fs-extra'),
      helpers = require('./helpers'),
      path = require('path'),
      request = require('sync-request');

module.exports = {
	createSite: createSite,
	deleteSite: deleteSite,
	getHosts: getHosts,
	getSites: getSites,
	getSiteSettings: getSiteSettings,
	hostsAllAdd: hostsAddAll,
	hostsRemoveAll: hostsRemoveAll,
	updateSitesNginxConfig: updateSitesNginxConfig
};

/**
 * Builds the Nginx config file for an individual site.
 *
 * @param {String} site
 *
 * @returns {String}
 */
function buildNginxConfigForSite(site) {

	// Check for nginx.conf override file in the site directory; if it exists, use it instead of programmatically
	// generating one.
	const nginxOverrideFile = path.join(config.sites_directory, site, 'nginx.conf');
	if (fs.existsSync(nginxOverrideFile)) {
		return fs.readFileSync(nginxOverrideFile, 'UTF-8');
	}

	const siteSettings = getSiteSettings(site);

	const configFileTemplate = path.join(environment.appDirectory, '/templates/nginx/', siteSettings.type + '-site.conf');
	let templateData = fs.readFileSync(configFileTemplate, 'UTF-8');

	const templateVars = {
		php_backend: config.default_php_backend,
		server_name: siteSettings.hosts.join(' '),
		site_name: site,
		wp_uploads_proxy_config: "\t# WP uploads proxy not configured for site"
	};

	// Add WP uploads proxy if applicable.
	if (siteSettings.wp_uploads_proxy_url) {
		const wpUploadsProxyTemplate = fs.readFileSync(path.join(environment.appDirectory, '/templates/nginx/wp-uploads-proxy.conf'), 'UTF-8');
		templateVars.wp_uploads_proxy_config = helpers.populateTemplate(wpUploadsProxyTemplate, {wp_uploads_proxy_url: siteSettings.wp_uploads_proxy_url});
	}

	// Add proxy port if applicable.
	if (siteSettings.proxy_port) {
		// Until Docker provides consistant hostname for hostmachines,
		// we need to check what OS we're on.
		// Read more: https://github.com/docker/for-mac/issues/1679
		let proxy_host
		if (process.platform === 'darwin') {
			proxy_host = 'docker.for.mac.localhost';
		} else if (process.platform === 'win32') {
			// This is untested
			proxy_host = 'docker.for.windows.localhost';
		} else {
			// This is untested
			proxy_host = '172.17.42.1';
		}
		templateVars.proxy_host = proxy_host;
		templateVars.proxy_port = siteSettings.proxy_port;
	}

	return helpers.populateTemplate(templateData, templateVars);
}

/**
 * Creates a new local site.
 *
 * @param {String} siteName   The name of the site to create.
 * @param {Object} siteConfig The site configuration data.
 */
function createSite(siteName, siteConfig) {

	let configFileSettings = {};

    if ('globalDefault' !== siteConfig.default_php_version) {
        configFileSettings.default_php_version = siteConfig.default_php_version;
    }

	if (siteName + '.' + config.default_tld !== siteConfig.domain) {
		configFileSettings.hosts = [siteConfig.domain];
	}

	if (siteConfig.wp_uploads_proxy_url) {
    	configFileSettings.wp_uploads_proxy_url = siteConfig.wp_uploads_proxy_url;
	}

	if (siteConfig.proxy_port) {
		configFileSettings.proxy_port = siteConfig.proxy_port;
		fs.ensureDirSync(path.join(config.sites_directory, siteName));
	} else {
		fs.ensureDirSync(path.join(config.sites_directory, siteName, 'htdocs'));
	}

	if ('laravel' === siteConfig.type || 'wordpress' === siteConfig.type || siteConfig.create_database) {
		commands.mysqlCommand('CREATE DATABASE IF NOT EXISTS `' + siteName + '`;');
	}

	environment.currentPathInSite = 'htdocs';
	environment.currentSiteName = siteName;
	environment.currentSiteRootDirectory = path.join(config.sites_directory, siteName);

	if ('laravel' === siteConfig.type) {

		commands.shellCommand(environment.currentSiteRootDirectory, 'composer', [
			'create-project',
			'--prefer-dist',
			'laravel/laravel',
			'htdocs'
		]);

		const laravelDotEnvConfigPath = path.join(environment.currentSiteRootDirectory, 'htdocs', '.env');
		const laravelDotEnvConfigDirectives = {
			APP_URL: 'https://' + siteConfig.domain,
			DB_HOST: 'mysql',
			DB_DATABASE: siteName,
			DB_USERNAME: 'pilothouse',
			DB_PASSWORD: 'pilothouse',
			MAIL_HOST: 'mailcatcher',
			MAIL_PORT: '1025',
			REDIS_HOST: 'redis'
		};
		let laravelDotEnvContent = fs.readFileSync(laravelDotEnvConfigPath, 'UTF-8');
		for (key in laravelDotEnvConfigDirectives) {
			let regex = new RegExp(key + '=.*?$', 'm');
			laravelDotEnvContent = laravelDotEnvContent.replace(regex, key + '=' + laravelDotEnvConfigDirectives[key]);
		}
		fs.writeFileSync(laravelDotEnvConfigPath, laravelDotEnvContent);

	} else if ('wordpress' === siteConfig.type) {

		// Download WP core files.
		commands.wpCommand([
			'core',
			'download'
		]);

		// Generate wp-config.php
		commands.wpCommand([
			'core',
			'config',
			'--dbhost=mysql',
			'--dbname=' + siteName,
			'--dbuser=pilothouse',
			'--dbpass=pilothouse'
		]);

		// Install WordPress.
		commands.wpCommand([
			'core',
			'install',
			'--url=' + siteConfig.domain,
			'--title=' + siteName,
			'--admin_user=' + config.wp_default_username,
			'--admin_password=' + config.wp_default_password,
			'--admin_email=' + config.wp_default_username + '@' + siteConfig.domain,
			'--skip-email'
		]);

		// Clone wp-content repo, if applicable.
		if (siteConfig.wp_content_repo_url) {

			commands.shellCommand(
				path.join(environment.currentSiteRootDirectory, 'htdocs'),
				'git',
				['clone', siteConfig.wp_content_repo_url, 'wp-content.tmp']
			);

			if (fs.existsSync(path.join(environment.currentSiteRootDirectory, 'htdocs/wp-content.tmp'))) {
				fs.moveSync(
					path.join(environment.currentSiteRootDirectory, 'htdocs/wp-content.tmp'),
					path.join(environment.currentSiteRootDirectory, 'htdocs/wp-content'),
					{overwrite: true}
				);
			} else {
				console.log(chalk.red('Could not clone the Git repository for wp-content.'));
			}
		}

		// Add object cache dropin.
		const objectCacheDropinRequest = request(
			'GET',
			'https://raw.githubusercontent.com/pantheon-systems/wp-redis/master/object-cache.php'
		);
		const objectCacheContent = objectCacheDropinRequest.getBody().toString();
		fs.writeFileSync(
			path.join(environment.currentSiteRootDirectory, 'htdocs/wp-content/object-cache.php'),
			objectCacheContent
		);

		// Update wp-config.php with additional directives.
		let wpConfigAdditionsFile = path.join(environment.appDirectory, 'config/wp-config.php.inc');
		if (fs.existsSync(path.join(environment.appHomeDirectory, 'wp-config.php.inc'))) {
			wpConfigAdditionsFile = path.join(environment.appHomeDirectory, 'wp-config.php.inc');
		}
		let wpConfigAdditionsContent = fs.readFileSync(wpConfigAdditionsFile, 'UTF-8');
		wpConfigAdditionsContent = helpers.populateTemplate(wpConfigAdditionsContent, {site_name: environment.currentSiteName});
		let wpConfigContent = fs.readFileSync(path.join(environment.currentSiteRootDirectory, 'htdocs/wp-config.php'), 'UTF-8');
		wpConfigContent = wpConfigContent.replace(/\n\n\/\* That's all/, wpConfigAdditionsContent + "\n\n/* That's all");
		fs.writeFileSync(path.join(environment.currentSiteRootDirectory, 'htdocs/wp-config.php'), wpConfigContent);

		// Register uploads proxy URL in config.
		if (siteConfig.uploadsProxyUrl) {
			configFileOverrides.wp_uploads_proxy_url = siteConfig.uploadsProxyUrl;
		}
	}

	if (Object.keys(configFileSettings).length) {
        saveSiteSettings(siteName, configFileSettings);
    }

	hostsAddOne(siteConfig.domain);
	updateSitesNginxConfig();
	commands.regenerateHTTPSCertificate(getHosts());
	commands.composeCommand(['restart', 'nginx']);
	console.log(chalk.green('Local site ' + siteName + ' at ' + siteConfig.domain + ' created.'));
}

/**
 * Deletes a local site.
 *
 * @param site The site to delete.
 */
function deleteSite(site) {
	fs.removeSync(path.join(config.sites_directory, site));
	updateSitesNginxConfig();
	commands.mysqlCommand('DROP DATABASE IF EXISTS `' + site + '`;');

	getSiteSettings(site).hosts.forEach(function(host) {
		hostsRemoveOne(host);
	});

	commands.regenerateHTTPSCertificate(getHosts());
	commands.composeCommand(['restart', 'nginx']);
	console.log(chalk.green('Local site ' + site + ' deleted.'));
}

/**
 * Builds a list of all valid local hostnames.
 *
 * @returns {Array}
 */
function getHosts() {
	let hosts = [];
	getSites().forEach(function(site) {
		const siteSettings = getSiteSettings(site);
		hosts = hosts.concat(siteSettings.hosts);
	});
	return hosts;
}

/**
 * Builds a list of all valid local sites.
 *
 * @returns {Array}
 */
function getSites() {
	return fs.readdirSync(config.sites_directory).filter(isValidSite);
}

/**
 * Gets the site-specific settings for an individual site.
 *
 * @param {String} site
 *
 * @returns {Object}
 */
function getSiteSettings(site) {
	const configFile = path.join(config.sites_directory, site, 'config.yml');
	const defaults = {
		default_php_version: config.default_php_version,
		hosts: [site + '.' + config.default_tld],
		type: 'php',
		wp_uploads_proxy_url: null,
		proxy_port: null
	};

	if (!fs.existsSync(path.join(config.sites_directory, site, 'htdocs'))) {
		defaults.type = 'proxy';
	}
	else if (fs.existsSync(path.join(config.sites_directory, site, 'htdocs/artisan'))) {
		defaults.type = 'laravel';
	}
	else if (fs.existsSync(path.join(config.sites_directory, site, 'htdocs/wp-config.php'))) {
		defaults.type = 'wordpress';
	}

	return helpers.readYamlConfig(configFile, defaults);
}

/**
 * Adds all local site hostnames to the hosts file.
 */
function hostsAddAll() {
	commands.shellCommand(environment.appDirectory, 'sudo', [
		'npm',
		'run',
		'hostile',
		'load',
		environment.runDirectory + '/hosts.txt'
	], true);
}

/**
 * Adds one local site hostname to the hosts file.
 */
function hostsAddOne(host) {
	commands.shellCommand(environment.appDirectory, 'sudo', [
		'npm',
		'run',
		'hostile',
		'set',
		'127.0.0.1',
		host
	], true);
}

/**
 * Removes all local site hostnames from the hosts file.
 */
function hostsRemoveAll() {
	commands.shellCommand(environment.appDirectory, 'sudo', [
		'npm',
		'run',
		'hostile',
		'unload',
		environment.runDirectory + '/hosts.txt'
	], true);
}

/**
 * Removes one local site hostname to the hosts file.
 */
function hostsRemoveOne(host) {
	commands.shellCommand(environment.appDirectory, 'sudo', [
		'npm',
		'run',
		'hostile',
		'remove',
		host
	], true);
}

/**
 * Determines whether the specified item is a valid site in the sites directory.
 *
 * @param {String} item The name of the item in the sites directory.
 *
 * @returns {Boolean}
 */
function isValidSite(item) {
	const fullPath = path.join(config.sites_directory, item);

	// Return false if this is not a directory.
	if (!fs.lstatSync(fullPath).isDirectory()) {
		return false;
	}

	// Return false if there is neither an htdocs directory nor a config.yml or an nginx.conf file inside.
	if (
		!fs.existsSync(path.join(fullPath, 'htdocs')) &&
		!fs.existsSync(path.join(fullPath, 'config.yml')) &&
		!fs.existsSync(path.join(fullPath, 'nginx.conf'))
	) {
		return false;
	}

	return true;
}

/**
 * Saves the site-specific settings for an individual site.
 *
 * @param {String} site
 * @param {Object} siteConfig
 */
function saveSiteSettings(site, siteConfig) {
    const configFile = path.join(config.sites_directory, site, 'config.yml');
    helpers.writeYamlConfig(configFile, siteConfig);
}

/**
 * Compiles and updates the aggregated sites Nginx configuration.
 */
function updateSitesNginxConfig() {
	const sites = getSites();
	let nginxCompiledConfig = '';

	const defaultSiteNginxConfig = fs.readFileSync(path.join(environment.appDirectory, 'config', 'nginx-default-site.conf'), 'UTF-8');
	nginxCompiledConfig += helpers.populateTemplate(defaultSiteNginxConfig, {php_backend: config.default_php_backend});

	sites.forEach(function(site) {
		nginxCompiledConfig += buildNginxConfigForSite(site) + "\n";
	});

	fs.outputFileSync(environment.runDirectory + '/nginx-compiled-sites.conf', nginxCompiledConfig);
}
